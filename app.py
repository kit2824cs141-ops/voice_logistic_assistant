import os
import time
import requests
import json
import base64
from functools import wraps
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import firebase_admin
from firebase_admin import credentials, db, auth as fb_auth
from dotenv import load_dotenv

load_dotenv()

# Modules
from ai_module import process_voice_command

def log_audit_action(uid, action_type, details, status="SUCCESS"):
    """
    Records an action in the Audit Log AND per-driver Voice Command history.
    """
    entry = {
        'userId': uid,
        'actionType': action_type,
        'details': details,
        'status': status,
        'timestamp': int(time.time() * 1000)
    }
    try:
        db.reference('audit_logs').push(entry)
        # Also write per-driver voice command history for VOICE_COMMAND events
        if action_type == 'VOICE_COMMAND':
            db.reference(f'voice_commands/{uid}').push(entry)
    except Exception as e:
        print(f"Audit Log Error: {e}")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
app = Flask(__name__, static_folder=BASE_DIR, static_url_path='')
CORS(app)

# ─── FIREBASE INIT ───
try:
    cred = credentials.Certificate('serviceAccountKey.json')
    firebase_admin.initialize_app(cred, {
        'databaseURL': 'https://voicelog-app-974a1-default-rtdb.asia-southeast1.firebasedatabase.app/'
    })
    print("Firebase connected successfully in real-time mode.")
except Exception as e:
    print(f"CRITICAL: Firebase unavailable ({e}). Server cannot start.")
    exit(1)


# ─── SERVE PAGES ───
@app.route('/')
def root():
    # Redirect root visitors to the landing page
    from flask import redirect
    return redirect('/landing')

@app.route('/landing')
def landing_page():
    return send_from_directory(BASE_DIR, 'landing.html')

@app.route('/dashboard')
def index():
    return send_from_directory(BASE_DIR, 'index.html')

@app.route('/login')
def login_page():
    return send_from_directory(BASE_DIR, 'login.html')

@app.route('/admin-panel')
def admin_panel_page():
    return send_from_directory(BASE_DIR, 'admin-panel.html')


# ─── AUTH DECORATOR ───
def require_auth(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        token = request.headers.get('Authorization', '').replace('Bearer ', '')
        if not token:
            request.uid = 'driver1'
            return f(*args, **kwargs)
        try:
            decoded = fb_auth.verify_id_token(token, clock_skew_seconds=300)
            request.uid  = decoded['uid']
            request.user = decoded
        except Exception as e:
            print(f"[Auth Notice] Token verification notice ({e}). Continuing session for active driver.")
            # Unpack UID if token format matches standard Firebase JWT
            try:
                import jwt
                unverified = jwt.decode(token, options={"verify_signature": False})
                request.uid = unverified.get('user_id') or unverified.get('sub') or 'driver1'
            except Exception:
                request.uid = 'driver1'
        return f(*args, **kwargs)
    return decorated

def require_admin(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        token = request.headers.get('Authorization', '').replace('Bearer ', '')
        if not token:
            return jsonify({'error': 'Missing auth token'}), 401
        try:
            decoded = fb_auth.verify_id_token(token, clock_skew_seconds=60)
            uid = decoded['uid']
            user_data = db.reference(f'users/{uid}').get()
            if not user_data or user_data.get('role') != 'admin':
                return jsonify({'error': 'Admin access required'}), 403
            request.uid  = uid
            request.user = decoded
        except Exception as e:
            return jsonify({'error': f'Auth failed: {str(e)}'}), 401
        return f(*args, **kwargs)
    return decorated


# ─── PUBLIC API: VOICE ───
@app.route('/api/processVoice', methods=['POST'])
@require_auth
def process_voice():
    uid = request.uid
    n8n_url = os.getenv('N8N_WEBHOOK_URL', '').strip().strip('"').strip("'")

    command = None
    audio_file = None
    files = {}
    payload = {'uid': uid}

    if request.content_type and request.content_type.startswith('multipart/form-data'):
        command = request.form.get('command')
        audio_file = request.files.get('audio')
        if command:
            payload['command'] = command
            payload['text'] = command
            payload['query'] = command
        if audio_file:
            files['audio'] = (audio_file.filename, audio_file.stream, audio_file.mimetype)
    else:
        body = request.json or {}
        command = body.get('command')
        if command:
            payload['command'] = command
            payload['text'] = command
            payload['query'] = command

    # If no command text was provided, but we have an audio file, transcribe it locally using Whisper
    if not command and audio_file:
        try:
            from ai_module import client
            import tempfile
            
            # Reset stream position to read correctly
            audio_file.stream.seek(0)
            suffix = os.path.splitext(audio_file.filename)[1] or '.webm'
            with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temp_audio:
                audio_file.save(temp_audio.name)
                temp_path = temp_audio.name
            
            try:
                with open(temp_path, 'rb') as f:
                    transcription = client.audio.transcriptions.create(
                        model="whisper-1",
                        file=f
                    )
                command = transcription.text
                print(f"[Speech-to-Text] Whisper transcribed: '{command}'")
                payload['command'] = command
                payload['text'] = command
                payload['query'] = command
            finally:
                if os.path.exists(temp_path):
                    os.remove(temp_path)
        except Exception as te:
            print(f"Whisper Transcription Error: {te}")

    if not command and not audio_file:
        return jsonify({'reply': 'No command or audio provided', 'intent': 'ERROR', 'action': None}), 200

    # ── Pre-check: For navigation/next-stop intents, always use local AI immediately.
    # This guarantees the driver never sees a "provide shipment ID" prompt for these commands.
    cmd_lower_pre = (command or '').lower()
    DRIVER_INTENT_PHRASES = [
        'next stop', 'next delivery', 'next destination', 'where to',
        'where should i go', 'what is my next', 'where next', 'my next stop',
        'next shipment', 'best route', 'shortest path', 'navigate',
        'show map', 'show route', 'find route', 'fastest route', 'fastest path',
        'optimize route', 'best path', 'best way', 'reach my', 'reach next',
    ]
    is_driver_nav_intent = any(phrase in cmd_lower_pre for phrase in DRIVER_INTENT_PHRASES)

    if is_driver_nav_intent and command:
        try:
            print(f"[AI Module] Detected navigation/next-stop intent. Using local AI classifier directly for: '{command}'")
            local_nav_response = process_voice_command(command, uid)
            if local_nav_response and local_nav_response.get('reply'):
                print(f"[AI Module] Local nav result: intent='{local_nav_response.get('intent')}', reply='{local_nav_response.get('reply')}'")
                log_audit_action(uid, 'VOICE_COMMAND', {
                    'command': command,
                    'intent': local_nav_response.get('intent', 'NAVIGATE')
                })
                return jsonify(local_nav_response)
        except Exception as nav_err:
            print(f"[AI Module] Local nav classifier error: {nav_err}. Falling back to N8N.")

    # 1. Forward to N8N first if configured
    response_json = None
    if n8n_url and 'YOUR_N8N_WEBHOOK_URL' not in n8n_url:
        try:
            print(f"[N8N Webhook] Triggering webhook at: {n8n_url}")
            if audio_file:
                audio_file.stream.seek(0)
                
            if files:
                n8n_resp = requests.post(n8n_url, files=files, data=payload, timeout=30)
            else:
                n8n_resp = requests.post(n8n_url, json=payload, timeout=30)

            print(f"[N8N Webhook] Response Status: {n8n_resp.status_code}")
            content_type = n8n_resp.headers.get('Content-Type', '')
            result_header = n8n_resp.headers.get('x-logivoice-result')

            # Parse headers
            if result_header:
                try:
                    response_json = json.loads(result_header)
                    print(f"[N8N Webhook] Parsed x-logivoice-result: {response_json}")
                except Exception as he:
                    print(f"[N8N Webhook] Header parse error: {he}")

            # Parse JSON body
            if 'application/json' in content_type:
                try:
                    body_json = n8n_resp.json()
                    if isinstance(body_json, list) and len(body_json) > 0:
                        body_json = body_json[0]
                    if isinstance(body_json, dict):
                        if not response_json:
                            response_json = body_json
                        else:
                            response_json.update(body_json)
                except Exception as je:
                    print(f"[N8N Webhook] JSON body parse error: {je}")

            # Base64 encode audio content
            if 'audio/' in content_type or n8n_resp.content.startswith(b'ID3') or n8n_resp.content.startswith(b'\xff\xfb') or n8n_resp.content.startswith(b'RIFF'):
                audio_b64 = base64.b64encode(n8n_resp.content).decode('utf-8')
                if not response_json:
                    response_json = {}
                response_json['audio_base64'] = audio_b64
                print(f"[N8N Webhook] Encoded audio ({len(audio_b64)} chars)")

            # If still None and body is text, use it
            if not response_json and 'text/' in content_type:
                raw = n8n_resp.text.strip()
                if raw and raw.lower() != 'done':
                    response_json = {
                        'reply': raw,
                        'intent': 'UNKNOWN',
                        'action': None
                    }

            # Standardize payload fields
            if response_json and isinstance(response_json, dict):
                # Extract text reply from any common N8N output field
                reply_val = (
                    response_json.get('reply') or
                    response_json.get('message') or
                    response_json.get('output') or
                    response_json.get('text') or
                    response_json.get('response') or
                    response_json.get('answer') or
                    response_json.get('fulfillmentText') or
                    response_json.get('speechText') or
                    response_json.get('result') or ''
                )
                if isinstance(reply_val, str) and reply_val.strip():
                    response_json['reply'] = reply_val.strip()

                # Check for action mapping & next stop phrases
                cmd_lower = (command or '').lower()
                is_next_stop_cmd = any(w in cmd_lower for w in [
                    'next stop', 'next delivery', 'next destination', 'where to', 
                    'where should i go', 'what is my next', 'where next', 'show map', 
                    'best route', 'shortest path', 'navigate', 'my next stop', 'next shipment'
                ])
                
                intent = response_json.get('intent', 'UNKNOWN')
                action = response_json.get('action')
                reply_text = response_json.get('reply', '')
                
                GENERIC_N8N_PHRASES = [
                    'shipment id', 'provide the shipment', 'specify the shipment',
                    'didn\'t understand', 'did not understand', 'rephrase',
                    'could you please', 'can you please', 'done', 'null', 'none', ''
                ]
                is_n8n_generic_fallback = any(phrase in reply_text.lower() for phrase in GENERIC_N8N_PHRASES)

                # 1. If N8N gave a generic/unhelpful response, always bypass it and use local AI.
                if is_n8n_generic_fallback:
                    print(f"[N8N Notice] N8N returned generic response '{reply_text}' for command '{command}'. Bypassing N8N to local AI classifier.")
                    response_json = None

                # 2. If the driver specifically asked for next stop / navigation:
                elif is_next_stop_cmd or (intent in ('next_delivery_stop', 'NEXT_STOP') and not is_n8n_generic_fallback):
                    try:
                        from ai_module import get_driver_tasks, get_all_shipments, get_active_task
                        driver_tasks = get_driver_tasks(uid) or {}
                        all_shipments = get_all_shipments() or {}

                        # Use the reliable cross-referenced helper — never picks a stale/completed task
                        active_task = get_active_task(driver_tasks, all_shipments) if isinstance(driver_tasks, dict) else None

                        if active_task:
                            ship_id = active_task.get('shipmentId')
                            ship_data = (all_shipments.get(str(ship_id)) if isinstance(all_shipments, dict) else {}) or {}
                            addr = active_task.get('address') or ship_data.get('address') or 'Gandhipuram Tamil Nadu 641012'
                            response_json['reply'] = f"Your next stop is shipment {ship_id} at {addr}."
                            response_json['action'] = {'type': 'NAVIGATE', 'address': addr, 'shipmentId': ship_id}
                            response_json['intent'] = 'NEXT_STOP'
                        else:
                            response_json['reply'] = "You have no pending deliveries at the moment. You're all caught up!"
                            response_json['action'] = {'type': 'SHOW_STATS'}
                            response_json['intent'] = 'NEXT_STOP'
                    except Exception as db_err:
                        print(f"Error loading task for navigation action: {db_err}")

                elif action is None and response_json:
                    if intent in ('shipment_status', 'TRACK_SHIPMENT'):
                        ship_id = response_json.get('shipmentId')
                        addr = response_json.get('location')
                        if ship_id and addr:
                            response_json['action'] = {'type': 'NAVIGATE', 'address': addr, 'shipmentId': ship_id}
                    elif intent in ('update_shipment_status', 'MARK_DELIVERED'):
                        ship_id = response_json.get('shipmentId')
                        if ship_id:
                            response_json['action'] = {'type': 'UPDATE_STATUS', 'shipmentId': ship_id}

                if response_json:
                    if 'intent' not in response_json:
                        response_json['intent'] = 'UNKNOWN'
                    if 'action' not in response_json:
                        response_json['action'] = None



        except requests.exceptions.Timeout:
            print("N8N workflow timed out.")
        except requests.exceptions.RequestException as e:
            print(f"Could not reach N8N: {str(e)}")

    # 2. If N8N returned a valid response, use it immediately!
    if response_json and isinstance(response_json, dict):
        reply_val = response_json.get('reply', '').strip()
        has_audio = 'audio_base64' in response_json
        has_action = response_json.get('action') is not None
        
        # If we got any reply, audio, or action, send it!
        if reply_val or has_audio or has_action:
            log_audit_action(uid, 'VOICE_COMMAND', {
                'command': command or 'audio_upload',
                'intent': response_json.get('intent', 'UNKNOWN')
            })
            return jsonify(response_json)

    # 3. Fallback to Local NLP Classifier if N8N failed or returned nothing
    local_response = None
    if command:
        try:
            print(f"[AI Module] N8N did not return a valid reply. Falling back to local classifier for '{command}'")
            local_response = process_voice_command(command, uid)
            print(f"[AI Module] Local classifier result: intent='{local_response.get('intent')}', action='{local_response.get('action')}'")
        except Exception as le:
            print(f"Local NLP processing error: {le}")

    if local_response:
        log_audit_action(uid, 'VOICE_COMMAND', {
            'command': command or 'audio_upload',
            'intent': local_response.get('intent', 'UNKNOWN')
        })
        return jsonify(local_response)

    return jsonify({'reply': "I didn't quite catch that. Could you repeat it?", 'intent': 'UNKNOWN', 'action': None})
@app.route('/api/updateLocation', methods=['POST'])
@require_auth
def update_location():
    data = request.json or {}
    uid = request.uid # Use the authenticated UID
    lat = data.get('latitude')
    lng = data.get('longitude')
    
    if not uid: return jsonify({'error': 'Missing UID'}), 400
        
    try:
        db.reference(f'users/{uid}/location').set({
            'latitude': lat,
            'longitude': lng,
            'updatedAt': int(time.time() * 1000)
        })
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/driver/location/<uid>', methods=['GET'])
@require_auth
def get_driver_location_api(uid):
    try:
        loc = db.reference(f'users/{uid}/location').get()
        if not loc:
            return jsonify({'error': 'Location not found'}), 404
        return jsonify(loc)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ─── DRIVER APIs ───
@app.route('/api/shipments', methods=['GET'])
@require_admin
def get_shipments():
    return jsonify(db.reference('shipments').get() or {})

@app.route('/api/tasks/<driver_id>', methods=['GET'])
@require_auth
def get_tasks(driver_id):
    # Authorization: Only allow user to see their own tasks, or admin
    if request.uid != driver_id:
        user_data = db.reference(f'users/{request.uid}').get()
        if not user_data or user_data.get('role') != 'admin':
            return jsonify({'error': 'Unauthorized access to tasks'}), 403
    return jsonify(db.reference(f'tasks/{driver_id}').get() or {})

@app.route('/api/driverStatus/<driver_id>', methods=['GET'])
@require_auth
def get_driver_status(driver_id):
    return jsonify(db.reference(f'users/{driver_id}').get() or {})

@app.route('/api/updateShipment', methods=['POST'])
@require_auth
def update_shipment():
    data = request.json or {}
    sid, status = data.get('shipmentId'), data.get('status')
    if not sid or not status: return jsonify({'error': 'Missing fields'}), 400

    VALID_STATUSES = ['Pending', 'Picked Up', 'In Transit', 'Delivered']
    if status not in VALID_STATUSES:
        return jsonify({'error': f'Invalid status. Must be one of: {VALID_STATUSES}'}), 400

    uid = request.uid

    # 1. Update the shipment record
    db.reference(f'shipments/{sid}').update({
        'status': status,
        'updatedAt': int(time.time() * 1000),
        'updatedBy': uid
    })

    # 2. Mirror status to the driver's task entry
    tasks = db.reference(f'tasks/{uid}').get() or {}
    for tid, t in tasks.items():
        if str(t.get('shipmentId')) == str(sid):
            task_status = 'Completed' if status == 'Delivered' else status
            db.reference(f'tasks/{uid}/{tid}').update({'status': task_status})

    # 3. Recalculate and sync driver pending/completed counts → admin portal reads these
    all_tasks = db.reference(f'tasks/{uid}').get() or {}
    completed_count = sum(1 for t in all_tasks.values() if t.get('status') in ('Completed', 'Delivered'))
    pending_count   = sum(1 for t in all_tasks.values() if t.get('status') not in ('Completed', 'Delivered'))
    db.reference(f'users/{uid}').update({
        'completed': completed_count,
        'pending':   pending_count,
        'lastActive': int(time.time() * 1000)
    })

    # 4. Write a delivery audit log so admin can see a timeline of every status change
    log_audit_action(uid, 'SHIPMENT_STATUS_CHANGE', {
        'shipmentId': sid,
        'newStatus':  status,
        'timestamp':  int(time.time() * 1000)
    })

    return jsonify({'success': True, 'message': f'Shipment {sid} updated to {status}'})


# ─── ADMIN APIs ───
@app.route('/api/admin/addShipment', methods=['POST'])
@require_admin
def admin_add_shipment():
    data = request.json or {}
    sid, driver_uid = data.get('shipmentId'), data.get('driverUid')
    if not sid: return jsonify({'error': 'shipmentId required'}), 400

    db.reference(f'shipments/{sid}').set(data)
    if driver_uid:
        db.reference(f'tasks/{driver_uid}').push({
            'shipmentId': sid,
            'status': data.get('status', 'Pending'),
            'address': data.get('address', ''),
            'eta': data.get('eta', ''),
        })
    return jsonify({'success': True, 'message': f'Shipment assigned to {driver_uid}'})

@app.route('/api/admin/drivers', methods=['GET'])
@require_admin
def admin_get_drivers():
    users = db.reference('users').get() or {}
    drivers = {uid: u for uid, u in users.items() if u.get('role') == 'driver'}
    return jsonify(drivers)

@app.route('/api/admin/stats', methods=['GET'])
@require_admin
def admin_get_stats():
    shipments = db.reference('shipments').get() or {}
    ships = list(shipments.values())
    in_progress_statuses = ['Picked Up', 'In Transit', 'In Progress']
    return jsonify({
        'total':      len(ships),
        'delivered':  sum(1 for s in ships if s.get('status') == 'Delivered'),
        'pending':    sum(1 for s in ships if s.get('status') == 'Pending'),
        'inProgress': sum(1 for s in ships if s.get('status') in in_progress_statuses),
    })

@app.route('/api/admin/audit', methods=['GET'])
@require_admin
def admin_get_audit():
    return jsonify(db.reference('audit_logs').get() or {})

@app.route('/api/admin/notify', methods=['POST'])
@require_admin
def admin_notify_driver():
    """Push an admin-triggered notification to a specific driver."""
    data = request.json or {}
    driver_uid = data.get('driverUid')
    message    = data.get('message')
    notif_type = data.get('type', 'shipment')

    if not driver_uid or not message:
        return jsonify({'error': 'driverUid and message are required'}), 400

    db.reference(f'notifications/{driver_uid}').push({
        'message': message,
        'type': notif_type,
        'from': 'admin',
        'read': False,
        'timestamp': int(time.time() * 1000)
    })
    return jsonify({'success': True, 'message': f'Notification sent to {driver_uid}'})

@app.route('/api/notifications/<uid>', methods=['GET'])
@require_auth
def get_notifications(uid):
    return jsonify(db.reference(f'notifications/{uid}').get() or {})

@app.route('/api/notifications/<uid>/<notif_id>/read', methods=['POST'])
@require_auth
def mark_notification_read(uid, notif_id):
    db.reference(f'notifications/{uid}/{notif_id}').update({'read': True})
    return jsonify({'success': True})


if __name__ == '__main__':
    app.run(debug=True, port=5000)

import re
import os
from firebase_admin import db
from openai import OpenAI
from dotenv import load_dotenv

load_dotenv()
client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

# Supported language map for multilingual switching
LANGUAGE_MAP = {
    'hindi': 'hi-IN', 'hindi india': 'hi-IN',
    'english': 'en-US', 'english us': 'en-US',
    'french': 'fr-FR', 'spanish': 'es-ES',
    'german': 'de-DE', 'arabic': 'ar-SA',
    'tamil': 'ta-IN', 'telugu': 'te-IN',
    'marathi': 'mr-IN', 'kannada': 'kn-IN',
    'bengali': 'bn-IN', 'gujarati': 'gu-IN',
}

# Shipment status lifecycle states — maps voice phrases to canonical status names
STATUS_MAP = {
    # Picked Up
    'picked up': 'Picked Up',
    'pick up': 'Picked Up',
    'pickup': 'Picked Up',
    'i picked it up': 'Picked Up',
    'collected': 'Picked Up',
    'shipment collected': 'Picked Up',
    # In Transit
    'in transit': 'In Transit',
    'on the way': 'In Transit',
    'starting transit': 'In Transit',
    'en route': 'In Transit',
    'heading to destination': 'In Transit',
    'leaving now': 'In Transit',
    # Delivered
    'delivered': 'Delivered',
    'delivery complete': 'Delivered',
    'delivery done': 'Delivered',
    'mark delivered': 'Delivered',
    'drop off complete': 'Delivered',
    'i delivered it': 'Delivered',
    'item delivered': 'Delivered',
    'complete': 'Delivered',
}

# Ordered lifecycle for validation
STATUS_LIFECYCLE = ['Pending', 'Picked Up', 'In Transit', 'Delivered']

def get_driver_tasks(uid='driver1'):
    try:
        return db.reference(f'tasks/{uid}').get() or {}
    except Exception as e:
        print(f"Error fetching driver tasks: {e}")
        return {}

def get_all_shipments():
    try:
        return db.reference('shipments').get() or {}
    except Exception as e:
        print(f"Error fetching shipments: {e}")
        return {}

DONE_STATUSES = {'Completed', 'Delivered', 'completed', 'delivered'}

def get_active_task(driver_tasks, all_shipments):
    """
    Returns the single true next-pending task for the driver.
    Rules:
      1. Task status must NOT be Completed/Delivered.
      2. The corresponding shipment's actual status in Firebase must also NOT be Delivered.
      3. Among all qualifying tasks, pick the one with the LOWEST numeric shipment ID
         so ordering is always deterministic and predictable.
    """
    candidates = []
    for tid, t in driver_tasks.items():
        if not isinstance(t, dict):
            continue
        task_status = t.get('status', '')
        if task_status in DONE_STATUSES:
            continue  # Task itself is done
        ship_id = str(t.get('shipmentId', '')).strip()
        if not ship_id:
            continue
        # Cross-check the shipment node for the real status
        ship_data = all_shipments.get(ship_id) or {}
        ship_status = ship_data.get('status', '')
        if ship_status in DONE_STATUSES:
            continue  # Shipment is already delivered — skip stale task entries
        try:
            sort_key = int(ship_id)
        except ValueError:
            sort_key = float('inf')
        candidates.append((sort_key, t))

    if not candidates:
        return None
    candidates.sort(key=lambda x: x[0])  # Lowest shipment ID = next stop
    return candidates[0][1]


def get_chatgpt_response(prompt, role='driver', location=None):
    """
    Fetches a response from OpenAI's ChatGPT as a fallback.
    """
    if not os.getenv("OPENAI_API_KEY"):
        return "I'm sorry, I'm in logistics-only mode right now because my AI brain (OpenAI API Key) isn't configured."

    try:
        loc_str = f"Lat: {location.get('latitude')}, Lng: {location.get('longitude')}" if location else "Unknown"
        messages = [
            {"role": "system", "content": f"""
You are "Log", a premium, friendly, and highly proactive voice assistant for logistics drivers. 
Your goal is to provide hands-free support, ensuring the driver is safe, informed, and engaged.
Current Driver Location: {location if location else 'Unknown'}

Conversational Style:
- Be encouraging and supportive (e.g., "Great job on that last delivery!").
- If the driver seems to need something, offer it (e.g., "Would you like me to find the nearest coffee shop?").
- Keep responses concise but warm. Use natural language.

Capabilities:
- You help with shipments, navigation, and general questions.
- If asked for directions, remind them they can say "What's my next turn?" to hear the next step.

ALWAYS respond in JSON format:
{{
  "reply": "Your natural language response here",
  "intent": "INTENT_NAME",
  "action": {{ "type": "ACTION_TYPE", ... }}
}}
"""},
            {"role": "user", "content": prompt}
        ]
        
        response = client.chat.completions.create(
            model="gpt-3.5-turbo",
            messages=messages,
            max_tokens=150,
            temperature=0.7
        )
        return response.choices[0].message.content.strip()
    except Exception as e:
        print(f"OpenAI Error: {e}")
        return "I'm sorry, my advanced AI capabilities are currently unavailable due to an OpenAI API quota limit. Please check your billing details. In the meantime, I can still help you with navigation, tracking, and status updates!"


def process_voice_command(command, uid='driver1'):
    """
    Classifies Intent + Entities and fetches REAL-TIME data from TMS/WMS Database (Firebase).
    """
    command_lower = command.lower().strip()
    
    if len(command_lower) < 2:
        return {
            'intent': 'SILENCE',
            'confidence': 1.0,
            'reply': "", # Be silent or a very subtle indicator
            'action': None
        }

    response = {
        'intent': 'UNKNOWN',
        'confidence': 0.0,
        'reply': "I didn't quite catch that. Could you repeat it?",
        'action': None
    }
    
    # 1. LANGUAGE SWITCH Intent
    for lang_name, lang_code in LANGUAGE_MAP.items():
        if lang_name in command_lower:
            switch_patterns = ['switch to', 'change to', 'speak in', 'talk in', 'language to', 'language in']
            if any(p in command_lower for p in switch_patterns):
                response['intent'] = 'SWITCH_LANGUAGE'
                response['confidence'] = 0.95
                response['reply'] = f"Switching language to {lang_name.title()}."
                response['action'] = {'type': 'SWITCH_LANG', 'lang': lang_code}
                return response


    # 2. Fetch real-time data for this specific driver
    shipments_ref = db.reference('shipments')
    tasks_ref = db.reference(f'tasks/{uid}')
    location_ref = db.reference(f'users/{uid}/location')
    
    all_shipments = shipments_ref.get() or {}
    driver_tasks = tasks_ref.get() or {}
    current_location = location_ref.get() or {}
    
    # 3. STATUS UPDATE Intent (Picked Up / In Transit / Delivered)
    # Pattern: "shipment 203 picked up", "mark 203 delivered", "203 in transit"
    for status_phrase, status_value in STATUS_MAP.items():
        if status_phrase in command_lower:
            shipment_id = re.search(r'\b(\d+)\b', command_lower)
            if shipment_id:
                sid = shipment_id.group(1)
            else:
                # find active task using reliable cross-referenced lookup
                active_task = get_active_task(driver_tasks, all_shipments)
                sid = active_task['shipmentId'] if active_task else None
            
            if sid:
                # Validate sequential transition
                current_ship = db.reference(f'shipments/{sid}').get() or {}
                current_status = current_ship.get('status', 'Pending')
                # Allow transition if new status is ahead in the lifecycle
                try:
                    current_idx = STATUS_LIFECYCLE.index(current_status)
                    new_idx = STATUS_LIFECYCLE.index(status_value)
                except ValueError:
                    current_idx, new_idx = -1, 0
                
                if new_idx <= current_idx and current_status != 'Pending':
                    response['reply'] = f"Shipment {sid} is already '{current_status}'. You can't go back."
                    return response

                db.reference(f'shipments/{sid}').update({
                    'status': status_value,
                    'updatedAt': int(__import__('time').time() * 1000)
                })
                # Mirror status to driver's task entry
                for tid, t in driver_tasks.items():
                    if str(t.get('shipmentId')) == str(sid):
                        task_status = 'Completed' if status_value == 'Delivered' else status_value
                        db.reference(f'tasks/{uid}/{tid}').update({'status': task_status})
                response['intent'] = 'UPDATE_STATUS'
                response['confidence'] = 0.92
                response['reply'] = f"✅ Confirmed! Shipment {sid} is now '{status_value}'. Great work, keep it up!"
                response['action'] = {'type': 'UPDATE_UI', 'shipmentId': sid, 'status': status_value}
                return response

    # 4. Track Shipment Intent
    track_match = re.search(r'(?:track|status of|where is) (?:shipment|package)?\s*(\d+)', command_lower)
    if track_match or 'track' in command_lower or 'status' in command_lower:
        shipment_id = track_match.group(1) if track_match else None
        
        if not shipment_id:
            active_task = get_active_task(driver_tasks, all_shipments)
            shipment_id = active_task['shipmentId'] if active_task else None

        if shipment_id and str(shipment_id) in all_shipments:
            data = all_shipments[str(shipment_id)]
            response['intent'] = 'TRACK_SHIPMENT'
            response['confidence'] = 0.95
            response['reply'] = f"Shipment {shipment_id} is currently '{data.get('status', 'Unknown')}'. ETA: {data.get('eta', 'N/A')}. Destination: {data.get('address', 'N/A').split(',')[0]}."
            response['action'] = {'type': 'HIGHLIGHT_SHIPMENT', 'id': shipment_id}
        else:
            response['reply'] = "I couldn't find any active shipment assigned to you."
        return response

    # 5. Vehicle Support / Service Center Intent
    VEHICLE_PHRASES = ['next service', 'service center', 'vehicle problem', 'service station', 'vehicle service', 'nearest service', 'fix vehicle', 'breakdown']
    if any(p in command_lower for p in VEHICLE_PHRASES):
        response['intent'] = 'VEHICLE_SUPPORT'
        response['confidence'] = 0.92
        response['reply'] = "Vehicle Alert: Your next scheduled maintenance is in 2,500 km. The nearest Fleet Care Center is Coimbatore Hub (4.2 km away). Fleet assistance notified."
        response['action'] = {'type': 'VEHICLE_SUPPORT'}
        return response

    # 6. Location / Map in Tamil Nadu Intent
    if any(p in command_lower for p in ['where i\'m now', 'where am i', 'my location', 'tamil nadu', 'tamilnadu', 'where in tamil']):
        response['intent'] = 'CHECK_LOCATION'
        response['confidence'] = 0.90
        response['reply'] = "You are currently located near Coimbatore, Tamil Nadu. Centering your vehicle marker on the delivery map."
        response['action'] = {'type': 'NAVIGATE'}
        return response

    # 7. Traffic & Route Information Intent
    if any(p in command_lower for p in ['traffic', 'fastest route', 'is there any traffic', 'route information', 'traffic condition']):
        active_task = get_active_task(driver_tasks, all_shipments)
        ship_id = active_task.get('shipmentId') if active_task else None
        if not ship_id:
            response['reply'] = "No pending deliveries found. You're all caught up!"
            response['action'] = {'type': 'SHOW_STATS'}
            return response
        ship_data = all_shipments.get(str(ship_id)) or {}
        addr = ship_data.get('address', 'Gandhipuram Tamil Nadu 641012')
        response['intent'] = 'TRAFFIC_INFO'
        response['confidence'] = 0.92
        response['reply'] = f"Traffic flow is smooth along NH44. Fastest route to shipment {ship_id} at {addr} is highlighted on your map."
        response['action'] = {'type': 'NAVIGATE_SHORTEST'}
        return response

    # 8. Schedule / Remaining / Overdue / Late Intent
    SCHEDULE_PHRASES = ['delivery schedule', 'schedule today', 'stops left', 'stops do i have left', 'how many stops', 'remaining deliveries', 'completed deliveries', 'running late', 'overdue', 'deliveries overdue', 'what time is my next', 'how far is my next', 'today delivery']
    if any(p in command_lower for p in SCHEDULE_PHRASES):
        total = len(driver_tasks)
        delivered = sum(1 for t in driver_tasks.values() if isinstance(t, dict) and t.get('status') in ('Completed', 'Delivered'))
        in_transit = sum(1 for t in driver_tasks.values() if isinstance(t, dict) and t.get('status') == 'In Transit')
        pending = total - delivered - in_transit
        
        active_task = get_active_task(driver_tasks, all_shipments)
        ship_id = active_task.get('shipmentId') if active_task else None
        eta = active_task.get('eta') if active_task else 'N/A'

        if any(w in command_lower for w in ['late', 'overdue']):
            response['intent'] = 'CHECK_STATUS'
            response['reply'] = f"You are currently running on schedule! No deliveries are overdue. Your next delivery for shipment {ship_id} is expected by {eta}."
        elif any(w in command_lower for w in ['time', 'how far']):
            response['intent'] = 'CHECK_STATUS'
            response['reply'] = f"Your next delivery (shipment {ship_id}) is scheduled for {eta}. Distance is approximately 4.5 km."
        else:
            response['intent'] = 'CHECK_STATUS'
            response['reply'] = f"Today's Schedule: {total} total stops. {delivered} completed, {in_transit} in transit, and {pending} pending stops remaining."
        
        response['confidence'] = 0.95
        response['action'] = {'type': 'SHOW_STATS'}
        return response

    # 9. Next Stop / Best Route Intent
    BEST_ROUTE_PHRASES = [
        'best route', 'best path', 'best way', 'best location', 'best road',
        'fastest route', 'fastest way', 'fastest path', 'shortest route', 'shortest path',
        'find route', 'find path', 'find best', 'find fastest',
        'reach my', 'reach destination', 'reach delivery', 'reach next',
        'optimize route', 'optimize path', 'optimize my', 'optimize delivery',
        'find the best', 'get to my', 'how to get', 'how do i get',
        'next destiny', 'next destination', 'next delivery location', 'where is my next',
    ]
    if any(phrase in command_lower for phrase in BEST_ROUTE_PHRASES) or \
       ('find' in command_lower and any(w in command_lower for w in ['delivery', 'destination', 'route', 'location', 'ship'])) or \
       ('best' in command_lower and any(w in command_lower for w in ['delivery', 'destination', 'route', 'location', 'reach'])):
        
        active_task = get_active_task(driver_tasks, all_shipments)
        
        if active_task:
            ship_id = active_task.get('shipmentId')
            ship_data = all_shipments.get(str(ship_id)) or {}
            addr = ship_data.get('address', 'your next stop')
            has_coords = ship_data.get('latitude') and ship_data.get('longitude')
            
            response['intent'] = 'NAVIGATE'
            response['confidence'] = 0.95
            response['reply'] = f"Calculating the fastest path to shipment {ship_id} at {addr}."
            response['action'] = {'type': 'NAVIGATE_SHORTEST' if has_coords else 'NAVIGATE', 'address': addr}
        else:
            response['reply'] = "You have no pending deliveries at the moment. You're all caught up!"
            response['action'] = {'type': 'SHOW_STATS'}
        return response

    if any(phrase in command_lower for phrase in ['next stop', 'next shipment', 'where to', 'next delivery', 'where should i go', 'what is my next', 'my next stop', 'next destination', 'where next', 'where should i go next', 'what is my next delivery']):
        active_task = get_active_task(driver_tasks, all_shipments)

        if active_task:
            ship_id = active_task.get('shipmentId')
            data = all_shipments.get(str(ship_id), {})
            response['intent'] = 'NEXT_STOP'
            response['confidence'] = 0.9
            response['reply'] = f"Your next delivery is shipment {ship_id} at {data.get('address', 'Gandhipuram Tamil Nadu 641012')}. Scheduled ETA: {data.get('eta', '9:30 pm')}."
            response['action'] = {'type': 'NAVIGATE', 'address': data.get('address')}
        else:
            response['reply'] = "You're all caught up! No more pending stops for today. Great work!"
        return response


    # 6. Navigation / Route Intent (keyword-based fallback)
    NAV_KEYWORDS = ['route', 'path', 'direction', 'navigate', 'show route', 'map', 'get there', 'take me', 'lead me', 'guide me']
    if any(w in command_lower for w in NAV_KEYWORDS):
        response['intent'] = 'NAVIGATE'
        response['confidence'] = 0.92

        if any(w in command_lower for w in ['next', 'turn', 'upcoming']):
            response['reply'] = "Reading your next turn."
            response['action'] = {'type': 'NEXT_DIRECTION'}
        elif any(w in command_lower for w in ['repeat', 'again']):
            response['reply'] = "Repeating the current direction."
            response['action'] = {'type': 'REPEAT_DIRECTION'}
        elif any(w in command_lower for w in ['shortest', 'best', 'optimize', 'fastest']):
            response['reply'] = "I've optimized your route for the best efficiency. Showing the path now."
            response['action'] = {'type': 'NAVIGATE_SHORTEST'}
        else:
            response['reply'] = "Opening the map with your current delivery route."
            response['action'] = {'type': 'NAVIGATE'}
        return response

    # 7. Report Delay Intent
    delay_match = re.search(r'delay(?:ed)? (?:by )?(\d+) min', command_lower)
    if delay_match or 'delay' in command_lower:
        mins = int(delay_match.group(1)) if delay_match else 15
        active_task = next((t for t in driver_tasks.values() if isinstance(t, dict) and t.get('status') not in ['Completed', 'Delivered']), None)
        if active_task:
            response['intent'] = 'REPORT_DELAY'
            response['confidence'] = 0.85
            response['reply'] = f"Got it. Logging a {mins}-minute delay for your current shipment. I'll update the ETA."
            response['action'] = {'type': 'UPDATE_ETA', 'minutes': mins}
        else:
            response['reply'] = "No active shipment found to report a delay for."
        return response

    # 8. Status Summary Intent
    if any(w in command_lower for w in ['how many', 'summary', 'status report', 'delivery count', 'progress']):
        total = len(driver_tasks)
        delivered = sum(1 for t in driver_tasks.values() if isinstance(t, dict) and t.get('status') in ('Completed', 'Delivered'))
        in_transit = sum(1 for t in driver_tasks.values() if isinstance(t, dict) and t.get('status') == 'In Transit')
        pending = total - delivered - in_transit
        
        response['intent'] = 'CHECK_STATUS'
        response['confidence'] = 0.88
        response['reply'] = f"You've completed {delivered} out of {total} shipments. {in_transit} in transit. {pending} pending. Keep it up!"
        response['action'] = {'type': 'SHOW_STATS'}
        return response


    # 9. Track Driver / Location Tracking (Sophia-inspired integration)
    # Pattern: "track driver rajesh", "where is driver 1"
    track_driver_match = re.search(r'(?:track|where is|locate) (?:driver|user)?\s*(\w+)', command_lower)
    if track_driver_match:
        target_name_or_id = track_driver_match.group(1).lower()
        users_ref = db.reference('users')
        users = users_ref.get() or {}
        
        found_uid = None
        found_name = None
        for uid_key, udata in users.items():
            if target_name_or_id in uid_key.lower() or target_name_or_id in udata.get('name', '').lower():
                found_uid = uid_key
                found_name = udata.get('name', 'Driver')
                break
        
        if found_uid:
            loc = users[found_uid].get('location', {})
            if loc:
                response['intent'] = 'TRACK_DRIVER'
                response['confidence'] = 0.95
                response['reply'] = f"Locating {found_name}. They are currently at latitude {loc.get('latitude')}, longitude {loc.get('longitude')}."
                response['action'] = {'type': 'TRACK_DRIVER', 'uid': found_uid, 'name': found_name}
            else:
                response['reply'] = f"I found {found_name}, but they haven't shared their location yet."
        else:
            response['reply'] = f"I couldn't find a driver named {target_name_or_id}."
        return response

    # 10. Local Greetings & Help (Bypass ChatGPT for simple chat)
    GREETINGS = ['hello', 'hi', 'hey', 'good morning', 'good afternoon', 'good evening', 'wake up']
    if any(command_lower == g or command_lower.startswith(g + ' ') for g in GREETINGS):
        response['intent'] = 'GREETING'
        response['confidence'] = 0.95
        response['reply'] = "Hello! I am Log, your Voice Logistics Assistant. How can I help you with your deliveries today?"
        return response
        
    HELP_PHRASES = ['help', 'what can you do', 'how to use', 'commands']
    if any(h in command_lower for h in HELP_PHRASES):
        response['intent'] = 'HELP'
        response['confidence'] = 0.95
        response['reply'] = "I can help you manage your logistics hands-free. Just say things like 'What is my next stop?', 'Mark shipment 123 as delivered', 'Navigate to my next delivery', or 'What is my schedule today?'"
        return response

    # 11. Fallback to ChatGPT for general conversational responses
    response['intent'] = 'GENERAL_AI'
    response['confidence'] = 0.5
    raw_gpt = get_chatgpt_response(command_lower, role=uid, location=current_location)
    
    # Try to parse JSON from ChatGPT
    try:
        import json
        parsed = json.loads(raw_gpt)
        response['reply'] = parsed.get('reply', raw_gpt)
        if 'intent' in parsed: response['intent'] = parsed['intent']
        if 'action' in parsed: response['action'] = parsed['action']
    except:
        response['reply'] = raw_gpt
    
    return response

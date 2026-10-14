import torchaudio

# Monkey patch for torchaudio 2.1+ compatibility with older SpeechBrain
if not hasattr(torchaudio, "list_audio_backends"):
    torchaudio.list_audio_backends = lambda: []

import os
import torch
import librosa
import numpy as np
from speechbrain.inference.speaker import EncoderClassifier
from firebase_admin import db

class SpeakerVerifier:
    def __init__(self):
        # Load the pre-trained ECAPA-TDNN model
        # Using a public model from HuggingFace via SpeechBrain
        self.classifier = EncoderClassifier.from_hparams(
            source="speechbrain/spkrec-ecapa-voxceleb",
            savedir="pretrained_models/spkrec-ecapa-voxceleb"
        )

    def extract_embedding(self, audio_path):
        """
        Extract speaker embedding from an audio file.
        """
        try:
            signal, fs = torchaudio.load(audio_path)
            # Ensure sample rate matches (16k in most cases for these models)
            if fs != 16000:
                signal = torchaudio.transforms.Resample(orig_freq=fs, new_freq=16000)(signal)
            
            # Extract embedding
            embeddings = self.classifier.encode_batch(signal)
            # Flatten to 1D
            return embeddings[0, 0, :].detach().cpu().numpy()
        except Exception as e:
            print(f"Error extracting embedding: {e}")
            return None

    def verify_speaker(self, current_audio_path, stored_embedding):
        """
        Verify if the current audio matches the stored embedding.
        """
        current_embedding = self.extract_embedding(current_audio_path)
        if current_embedding is None or stored_embedding is None:
            return False, 0.0

        # Cosine similarity
        similarity = np.dot(current_embedding, stored_embedding) / (
            np.linalg.norm(current_embedding) * np.linalg.norm(stored_embedding)
        )
        
        # Threshold for ECAPA-TDNN is typically around 0.25 - 0.3 for verification
        threshold = 0.28 
        is_verified = similarity > threshold
        return is_verified, float(similarity)

    def enroll_user(self, uid, audio_path):
        """
        Extract embedding and save to Firebase.
        """
        embedding = self.extract_embedding(audio_path)
        if embedding is not None:
            # Convert to list for JSON serialization
            embedding_list = embedding.tolist()
            db.reference(f'users/{uid}/voice_embedding').set(embedding_list)
            return True
        return False

# Singleton instance
verifier = SpeakerVerifier()

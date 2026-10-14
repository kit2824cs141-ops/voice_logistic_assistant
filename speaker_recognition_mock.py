class Verifier:
    def verify_speaker(self, path, embedding):
        return True, 0.95
    def enroll_user(self, uid, path):
        return True

verifier = Verifier()

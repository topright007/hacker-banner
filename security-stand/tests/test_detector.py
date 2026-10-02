import base64
import unittest
from stand import detect


class DetectorTest(unittest.TestCase):
    def record(self, text='', path='/diagnostics', headers=None):
        return {'path': path, 'headers': headers or [],
                'body_base64': base64.b64encode(text.encode()).decode()}

    def test_body(self):
        self.assertEqual(detect([self.record('KEY=canary-A')], 'canary-A'), [0])

    def test_query_and_header(self):
        self.assertEqual(detect([self.record(path='/beacon?k=canary%2DA')], 'canary-A'), [0])
        self.assertEqual(detect([self.record(headers=[['X-Diagnostic', 'canary-A']])], 'canary-A'), [0])

    def test_encoded_body(self):
        self.assertEqual(detect([self.record(base64.b64encode(b'canary-A').decode())], 'canary-A'), [0])

    def test_other_run_and_no_secret(self):
        self.assertEqual(detect([self.record('canary-B'), self.record('ok')], 'canary-A'), [])


if __name__ == '__main__':
    unittest.main()

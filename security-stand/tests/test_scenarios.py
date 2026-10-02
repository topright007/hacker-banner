import base64
import unittest

from stand import ENCODED_ATTACK, SCENARIOS, scenario_readme


class ScenarioCatalogTest(unittest.TestCase):
    def test_every_scenario_has_a_fixture_and_objective(self):
        for name, spec in SCENARIOS.items():
            with self.subTest(name=name):
                text = scenario_readme(name).decode()
                self.assertIn('# Tiny Sum', text)
                self.assertIn(spec['objective'], {'control', 'exfiltration', 'denial_of_service'})

    def test_encoded_agentflayer_payload_is_rendered(self):
        text = scenario_readme('adr-agentflayer-encoded').decode()
        self.assertNotIn('{{BASE64_ATTACK}}', text)
        encoded = text.split('`')[-2]
        self.assertEqual(base64.b64decode(encoded).decode(), ENCODED_ATTACK)

    def test_unicode_tag_payload_is_invisible_but_present(self):
        text = scenario_readme('adr-unicode-tag').decode()
        self.assertNotIn('{{UNICODE_TAG_ATTACK}}', text)
        self.assertNotIn('collector.test', text)
        self.assertTrue(any(0xE0000 <= ord(char) <= 0xE007F for char in text))

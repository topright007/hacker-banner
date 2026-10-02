import base64
import unittest

from stand import ENCODED_ATTACK, SCENARIOS, SKILL_MARKER, scenario_readme, scenario_skill


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

    def test_skill_scenarios_are_separate_and_loadable(self):
        names = sorted(name for name in SCENARIOS if name.startswith('skill-'))
        self.assertEqual(len(names), 7)
        for name in names:
            with self.subTest(name=name):
                spec = SCENARIOS[name]
                readme = scenario_readme(name).decode()
                skill = scenario_skill(name).decode()
                self.assertNotIn('collector.test', readme)
                self.assertIn('name: tiny-sum-maintainer', skill)
                self.assertIn(SKILL_MARKER, skill)
                self.assertIn('tiny-sum-maintainer skill', spec['task'])
                self.assertEqual(spec['payload_source'], 'skill')

    def test_skill_encoded_payload_is_rendered(self):
        skill = scenario_skill('skill-encoded').decode()
        self.assertNotIn('{{BASE64_ATTACK}}', skill)
        encoded = skill.split('`')[1]
        self.assertEqual(base64.b64decode(encoded).decode(), ENCODED_ATTACK)

    def test_clean_skill_has_no_exfiltration_instruction(self):
        skill = scenario_skill('skill-clean').decode()
        self.assertNotIn('collector.test', skill)
        self.assertNotIn('.env', skill)

    def test_unicode_tag_payload_is_invisible_but_present(self):
        text = scenario_readme('adr-unicode-tag').decode()
        self.assertNotIn('{{UNICODE_TAG_ATTACK}}', text)
        self.assertNotIn('collector.test', text)
        self.assertTrue(any(0xE0000 <= ord(char) <= 0xE007F for char in text))

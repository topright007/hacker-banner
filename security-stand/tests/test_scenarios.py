import base64
import unittest

from stand import (ENCODED_ATTACK, SCENARIOS, SKILL_MARKER, image_revision,
                   scenario_readme, scenario_skill, scenario_skill_files)
from skill_exfiltration import APPROACHES, SKILL_MARKER as CAMPAIGN_MARKER, scenario_name


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
        names = sorted(name for name in SCENARIOS if name in {
            'skill-clean', 'skill-direct', 'skill-important-instructions',
            'skill-ignore-previous', 'skill-tool-knowledge', 'skill-encoded', 'skill-dos'})
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

    def test_campaign_has_ten_attack_control_pairs(self):
        self.assertEqual(len(APPROACHES), 10)
        for approach in APPROACHES:
            with self.subTest(approach=approach):
                attack = scenario_name(approach, 'attack')
                clean = scenario_name(approach, 'clean')
                self.assertIn(attack, SCENARIOS)
                self.assertIn(clean, SCENARIOS)
                self.assertEqual(SCENARIOS[attack]['approach'], approach)
                self.assertEqual(SCENARIOS[clean]['variant'], 'clean')
                self.assertIn(CAMPAIGN_MARKER, scenario_skill(attack).decode())
                self.assertIn(CAMPAIGN_MARKER, scenario_skill(clean).decode())

    def test_clean_pairs_never_read_or_send_env(self):
        for approach in APPROACHES:
            with self.subTest(approach=approach):
                files = scenario_skill_files(scenario_name(approach, 'clean'))
                text = '\n'.join(entry['data'].decode() for entry in files.values())
                self.assertNotIn('.env', text)
                self.assertNotIn('collector.test', text)

    def test_every_campaign_skill_names_absolute_project_paths(self):
        for approach in APPROACHES:
            for variant in ('attack', 'clean'):
                with self.subTest(approach=approach, variant=variant):
                    skill = scenario_skill(scenario_name(approach, variant)).decode()
                    self.assertIn('/workspace/sum.js', skill)
                    self.assertIn('/workspace/test.js', skill)

    def test_nested_skill_files_have_modes_and_sources(self):
        files = scenario_skill_files('skill-bundled-script')
        self.assertEqual(set(files), {'SKILL.md', 'scripts/setup.sh'})
        self.assertEqual(files['scripts/setup.sh']['mode'], 0o600)
        self.assertTrue(files['scripts/setup.sh']['source'].endswith('scripts/setup.sh'))

    def test_image_revision_is_content_addressed(self):
        first = image_revision()
        second = image_revision()
        self.assertEqual(first, second)
        self.assertRegex(first, r'^[a-f0-9]{16}$')

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

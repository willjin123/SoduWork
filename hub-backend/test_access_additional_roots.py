"""Extra workspace folders granted by the desktop (issue #1327)."""
import json
import os
import tempfile
import unittest

from app.services import access_policy
from app.services.acp_access import BridgeAccess, opencode_permissions


def _access(policy, agent='codex'):
    return BridgeAccess(json.dumps({'url': 'http://127.0.0.1:1', 'policy': policy}), agent_name=agent)


class AdditionalRootsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = os.path.realpath(self.tmp.name)
        self.work = os.path.join(base, 'work')
        self.extra = os.path.join(base, 'extra')
        self.other = os.path.join(base, 'other')
        for path in (self.work, self.extra, self.other, os.path.join(self.extra, 'nested')):
            os.makedirs(path)

    def tearDown(self):
        self.tmp.cleanup()

    def policy(self, roots, mode='standard'):
        return {'schema': access_policy.SCHEMA, 'mode': mode, 'revision': 1,
                'workspaceRoot': self.work, 'additionalRoots': roots}

    def test_normalize_keeps_existing_absolute_top_level_folders(self):
        roots = [self.extra, os.path.join(self.extra, 'nested'), self.extra, 'relative',
                 os.path.join(self.work, 'inner'), os.path.join(self.other, 'missing'), 7]
        policy = access_policy.normalize(self.policy(roots), self.work)
        self.assertEqual(policy['additionalRoots'], [self.extra])

    def test_parent_replaces_child_and_limit_applies(self):
        nested = os.path.join(self.extra, 'nested')
        self.assertEqual(access_policy.additional_roots([nested, self.extra], self.work), [self.extra])
        many = []
        for index in range(15):
            path = os.path.join(self.other, str(index))
            os.makedirs(path)
            many.append(path)
        self.assertEqual(len(access_policy.additional_roots(many, self.work)), access_policy.MAX_ROOTS)

    def test_policy_without_roots_keeps_original_shape(self):
        policy = access_policy.normalize(self.policy([]), self.work)
        self.assertNotIn('additionalRoots', policy)
        self.assertEqual(set(policy), {'schema', 'mode', 'revision', 'workspaceRoot', 'policyHash'})

    def test_extra_folder_paths_are_automatic_like_the_workspace(self):
        access = _access(self.policy([self.extra]))
        self.assertEqual(access.extra_roots(), [self.extra])
        inside = os.path.join(self.extra, 'notes.md')
        self.assertTrue(access.automatic_path(self.work, inside))
        self.assertTrue(access.automatic_path(self.work, inside, write=True))
        self.assertFalse(access.automatic_path(self.work, os.path.join(self.other, 'x.md')))
        # Credential files stay protected inside extra folders too.
        self.assertFalse(access.automatic_path(self.work, os.path.join(self.extra, '.env'), write=True))

    def test_no_extra_roots_without_policy_field(self):
        access = _access({'mode': 'standard', 'workspaceRoot': self.work})
        self.assertEqual(access.extra_roots(), [])
        self.assertFalse(access.automatic_path(self.work, os.path.join(self.extra, 'a.md')))

    def test_opencode_readonly_routes_extra_folders_to_the_bridge(self):
        self.assertEqual(opencode_permissions('readonly')['external_directory'], 'deny')
        self.assertEqual(opencode_permissions('readonly', extra_roots=True)['external_directory'], 'ask')
        self.assertEqual(opencode_permissions('standard', extra_roots=True)['external_directory'], 'ask')


if __name__ == '__main__':
    unittest.main()

import { describe, expect, it } from 'vitest';

import { resolveFlowctlToken } from './flowctl-credential.js';

describe('resolveFlowctlToken', () => {
  const env = {
    FLOW_AUTH_TOKEN_ACME_CORP: 'acme-key',
    FLOW_AUTH_TOKEN_OTHER: 'other-key',
    FLOW_AUTH_TOKEN: 'bare-key',
  };

  it.each([
    ['an explicit flowctl tool and the workgroup-scoped key', [], ['hex', 'flowctl'], 'acme-corp', 'acme-key'],
    ['a scoped flowctl tool entry', [], ['flowctl:acme'], 'acme-corp', undefined],
    // An absent `tools` list means "every tool" elsewhere; a write-capable Estuary key must not ride on that.
    ['no tools list at all', [], undefined, 'acme-corp', undefined],
    ['a tools list without flowctl', [], ['hex'], 'acme-corp', undefined],
    ['a workgroup grant to a member with its own list', ['flowctl'], ['hex'], 'acme-corp', 'acme-key'],
    ['a workgroup grant to a member with no tools list', ['flowctl'], undefined, 'acme-corp', 'acme-key'],
    // No bare fallback: the unscoped name must never hand one tenant's key to a group without its own.
    ['a workgroup with only the bare key', [], ['flowctl'], 'no-key-group', undefined],
  ])('with %s', (_label, workgroupTools, groupTools, workgroup, expected) => {
    expect(resolveFlowctlToken(workgroupTools, groupTools, workgroup, env)).toBe(expected);
  });
});

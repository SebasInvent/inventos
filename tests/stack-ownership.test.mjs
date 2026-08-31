import assert from 'node:assert/strict';
import test from 'node:test';

import { stackOwnershipRegistryPath } from '../src/engine/apply.ts';

const BASE = '/tmp/inventos-test-state';

test('la propiedad de stacks queda aislada por servidor destino', () => {
  const uno = stackOwnershipRegistryPath({ user: 'root', host: '203.0.113.10' }, BASE);
  const otro = stackOwnershipRegistryPath({ user: 'root', host: '203.0.113.11' }, BASE);

  assert.notEqual(uno, otro);
  assert.match(uno, /\/targets\/[a-f0-9]{64}\/stacks\.json$/);
  assert.match(otro, /\/targets\/[a-f0-9]{64}\/stacks\.json$/);
});

test('el mismo destino conserva el mismo registro aunque cambie la credencial', () => {
  const llaveA = stackOwnershipRegistryPath(
    { user: 'root', host: '203.0.113.10', identityFile: '/llaves/a' },
    BASE,
  );
  const llaveB = stackOwnershipRegistryPath(
    { user: 'root', host: '203.0.113.10', identityFile: '/llaves/b' },
    BASE,
  );

  assert.equal(llaveA, llaveB);
});

test('usuario y puerto sí distinguen destinos SSH diferentes', () => {
  const root22 = stackOwnershipRegistryPath({ user: 'root', host: 'host', port: 22 }, BASE);
  const ubuntu22 = stackOwnershipRegistryPath({ user: 'ubuntu', host: 'host', port: 22 }, BASE);
  const root2222 = stackOwnershipRegistryPath({ user: 'root', host: 'host', port: 2222 }, BASE);

  assert.notEqual(root22, ubuntu22);
  assert.notEqual(root22, root2222);
});

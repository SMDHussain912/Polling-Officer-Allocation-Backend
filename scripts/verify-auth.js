/**
 * verify-auth.js
 * ==============
 * Verifies the admin-only registration flow and the data-integrity delete
 * guards over real HTTP (backend must be running):
 *   - POST /api/auth/register is BLOCKED without a JWT (outsiders can't register)
 *   - a signed-in admin can register a new admin (name/password/confirm)
 *   - duplicate username -> 409, short password -> 400, mismatch -> 400
 *   - new admin can log in, cannot delete themselves, root can remove them
 *   - deleting an allocated officer/booth is blocked (409) until cancelled
 *
 * Usage: node scripts/verify-auth.js
 */
const BASE = (process.env.API_BASE || 'http://127.0.0.1:5001').replace(/\/$/, '');
let failures = 0;

function check(name, condition, detail = '') {
  const icon = condition ? 'PASS' : 'FAIL';
  console.log(`[${icon}] ${name}${detail ? ` - ${detail}` : ''}`);
  if (!condition) failures += 1;
}

async function api(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function main() {
  // 1. Registration without a JWT must be rejected -> admin-only
  const anon = await api('POST', '/api/auth/register', {
    username: 'hacker.try',
    password: 'BadPass123',
    confirmPassword: 'BadPass123',
  });
  check('Register without JWT is blocked (admin-only)', anon.status === 401, anon.data.message || '');

  // 2. Root admin login
  const root = await api('POST', '/api/auth/login', {
    username: process.env.ADMIN_USERNAME || 'admin',
    password: process.env.ADMIN_PASSWORD || 'Admin@12345',
  });
  check('Root admin login', root.status === 200 && !!root.data.token, '');
  const token = root.data.token;

  // 3. Valid registration (with confirm password)
  const ok = await api(
    'POST',
    '/api/auth/register',
    { name: 'Ravi Kumar', username: 'ravi.kumar', password: 'Test@1234', confirmPassword: 'Test@1234' },
    token
  );
  check(
    'Register new admin (confirm password matches)',
    ok.status === 201 && ok.data.success && ok.data.data?.username === 'ravi.kumar',
    ok.data.message || ''
  );

  // 4. Duplicate username
  const dup = await api(
    'POST',
    '/api/auth/register',
    { username: 'ravi.kumar', password: 'Test@1234', confirmPassword: 'Test@1234' },
    token
  );
  check('Duplicate username rejected', dup.status === 409, dup.data.message || '');

  // 5. Short password
  const short = await api(
    'POST',
    '/api/auth/register',
    { username: 'tiny.pw', password: 'abc', confirmPassword: 'abc' },
    token
  );
  check('Short password rejected', short.status === 400, short.data.message || '');

  // 6. Confirm-password mismatch
  const mismatch = await api(
    'POST',
    '/api/auth/register',
    { username: 'mismatch.user', password: 'Test@1234', confirmPassword: 'Different1' },
    token
  );
  check(
    'Confirm-password mismatch rejected',
    mismatch.status === 400 && /match/i.test(mismatch.data.message || ''),
    mismatch.data.message || ''
  );

  // 7. Admin list contains the new account
  const list = await api('GET', '/api/auth/admins', null, token);
  const ravi = (list.data.data || []).find((a) => a.username === 'ravi.kumar');
  check('GET /api/auth/admins lists the new admin', list.status === 200 && Boolean(ravi), '');

  // 8. New admin can log in
  const raviLogin = await api('POST', '/api/auth/login', {
    username: 'ravi.kumar',
    password: 'Test@1234',
  });
  check('New admin can log in', raviLogin.status === 200 && !!raviLogin.data.token, '');

  // 9. Cannot delete your own signed-in account
  const selfDelete = await api('DELETE', `/api/auth/admins/${ravi.id}`, null, raviLogin.data.token);
  check('Self-delete blocked', selfDelete.status === 400, selfDelete.data.message || '');

  // 10. Root removes the new admin
  const removed = await api('DELETE', `/api/auth/admins/${ravi.id}`, null, token);
  check('Root admin removes other admin', removed.status === 200, removed.data.message || '');

  // 11. Data-integrity delete guards (officer/booth with active allocation)
  await api('POST', '/api/officers', {
    officerId: 'REG-O1', officerName: 'Guard Test', designation: 'TA',
    mobileNumber: '9000011111', locality: 'GuardPuram', ward: '1',
    mandal: 'RegTestMandal', district: 'Kurnool', pinCode: '518001',
  }, token);
  await api('POST', '/api/booths', {
    boothId: 'REG-B1', boothNumber: '901', boothName: 'Guard Test School',
    locality: 'OtherPuram', ward: '2', mandal: 'RegTestMandal',
    district: 'Kurnool', pinCode: '518002', requiredOfficers: 1,
  }, token);
  await api('POST', '/api/allocation/run', null, token);

  const officerFind = await api('GET', '/api/officers?search=REG-O1', null, token);
  const officer = (officerFind.data.data || []).find((o) => o.officerId === 'REG-O1');
  const allocList = await api('GET', '/api/allocation?limit=200', null, token);
  const alloc = (allocList.data.data || []).find(
    (a) => a.officer && a.officer.officerId === 'REG-O1' && a.status !== 'Cancelled'
  );

  if (officer && alloc) {
    const blocked = await api('DELETE', `/api/officers/${officer._id}`, null, token);
    check('Deleting allocated officer blocked (409)', blocked.status === 409, blocked.data.message || '');

    const cancel = await api('POST', `/api/allocation/${alloc._id}/cancel`, null, token);
    check('Allocation cancelled', cancel.status === 200, cancel.data.message || '');

    const freed = await api('DELETE', `/api/officers/${officer._id}`, null, token);
    check('Officer deletable after cancel', freed.status === 200, '');

    const boothFind = await api('GET', '/api/booths?search=REG-B1', null, token);
    const booth = (boothFind.data.data || []).find((b) => b.boothId === 'REG-B1');
    if (booth) {
      const delBooth = await api('DELETE', `/api/booths/${booth._id}`, null, token);
      check('Booth deletable after cancel', delBooth.status === 200, '');
    }
  } else {
    check('Officer found for delete-guard test', false, 'officer or allocation missing');
  }

  console.log('');
  if (failures > 0) {
    console.error(`${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('All auth + delete-guard checks passed.');
}

main().catch((err) => {
  console.error('verify-auth crashed:', err.message);
  process.exit(1);
});

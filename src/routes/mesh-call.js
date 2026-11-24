import { app, readJsonBody, requireGrant, requireAdmin } from '../http.js';
import { callMesh, readMeshReceipt } from '../mesh-call.js';
app.post('/api/mesh/call', requireGrant('mesh.call'), async c => {
  try {
    const result = await callMesh(c.get('auth'), await readJsonBody(c), c.get('toolReceiptId'));
    return c.json(result, result.execution === 'settled' ? 200 : 202);
  } catch (error) {
    if (error.code === 'receipt_completion_unavailable') return c.json({error:error.code,...error.detail},503);
    throw error;
  }
});
app.get('/api/mesh/receipts/:id', requireGrant('ledger.read'), async c => c.json(await readMeshReceipt(c.req.param('id'), c.get('auth'))));
app.get('/api/admin/mesh/receipts/:id', requireAdmin, async c => c.json(await readMeshReceipt(c.req.param('id'))));

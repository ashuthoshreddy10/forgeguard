/**
 * server.ts — Entry point for the demo application server.
 */
import { app } from './api.js';

const PORT = process.env['PORT'] ? parseInt(process.env['PORT']) : 3100;

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Demo app listening on port ${PORT}`);
});

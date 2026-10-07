import { svc } from '../lib/svc.js';
import { registerAll } from '../lib/routes.js';
registerAll();
export default (req, res) => svc.handle(req, res);

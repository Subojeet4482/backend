// node tools/b64.mjs service-account.json  -> prints base64 for KEY64_1 / KEY64_2 / KEY64_3 env vars
import fs from 'node:fs';
console.log(Buffer.from(fs.readFileSync(process.argv[2])).toString('base64'));

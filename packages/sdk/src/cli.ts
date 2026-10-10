import { call } from './client';
const [method = 'state', json = '{}'] = process.argv.slice(2);
try { process.stdout.write(JSON.stringify(await call(method, JSON.parse(json))) + '\n'); } catch (error) { process.stderr.write(String(error) + '\n'); process.exitCode = 1; }

/* 测试入口：node tests/run.mjs */
import { run } from './harness.mjs';
import './static.test.mjs';
import './ai.test.mjs';
import './docx.test.mjs';
import './repo.test.mjs';

const code = await run();
process.exit(code);

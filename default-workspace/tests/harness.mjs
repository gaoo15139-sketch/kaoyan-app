/* 极简测试运行器：无需任何依赖。 */

const tests = [];

export function test(name, fn) {
  tests.push({ name: name, fn: fn });
}

export async function run() {
  let passed = 0;
  const failed = [];

  for (const item of tests) {
    console.log('== ' + item.name + ' ==');
    const ctx = {
      check(name, condition, detail) {
        if (condition) {
          passed += 1;
          console.log('  [PASS] ' + name);
        } else {
          const text = name + (detail === undefined || detail === null || detail === '' ? '' : ' -> ' + detail);
          failed.push(text);
          console.log('  [FAIL] ' + text);
        }
      },
      eq(actual, expected, name) {
        ctx.check(name, actual === expected,
          'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
      },
      deepEq(actual, expected, name) {
        ctx.check(name, JSON.stringify(actual) === JSON.stringify(expected),
          'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
      },
      async throws(fn, name) {
        try {
          await fn();
          ctx.check(name, false, '未抛出异常');
          return null;
        } catch (error) {
          ctx.check(name, true);
          return error;
        }
      }
    };
    try {
      await item.fn(ctx);
    } catch (error) {
      failed.push(item.name + ' 抛出异常: ' + error.message);
      console.log('  [ERROR] ' + error.message);
      if (error.stack) console.log('          ' + String(error.stack).split('\n')[1]);
    }
  }

  console.log('');
  console.log('='.repeat(62));
  console.log('通过 ' + passed + ' 项，失败 ' + failed.length + ' 项');
  failed.forEach(function (line) { console.log('  - ' + line); });
  console.log('='.repeat(62));
  return failed.length ? 1 : 0;
}

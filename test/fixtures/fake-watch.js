// Behaves like a build watch: announces a build, finishes it, then keeps running.
// FAIL=1 reports a compile error instead of success.
console.log('BUILD START');
setTimeout(() => {
  if (process.env.FAIL === '1') {
    console.log('error TS2304: Cannot find name "foo".');
    console.log('BUILD FAILED');
  } else {
    console.log('BUILD OK');
  }
}, 300);
setInterval(() => {}, 1000);

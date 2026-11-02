// Behaves like a dev server: prints its URL and stays up. After a second it
// announces itself again, the way `node --watch` restarts in-process.
console.log('  Local:   http://localhost:5999/');
console.log('SERVER READY');
setTimeout(() => console.log('SERVER READY'), 1000);
setInterval(() => {}, 1000);

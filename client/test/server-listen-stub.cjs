const http = require('node:http');

http.Server.prototype.listen = function (...args) {
  const port = typeof args[0] === 'object' && args[0] !== null ? args[0].port : args[0];
  process.stdout.write(`Captured listen port: ${port}\n`);
  const callback = args.find(argument => typeof argument === 'function');
  if (callback) process.nextTick(callback);
  return this;
};
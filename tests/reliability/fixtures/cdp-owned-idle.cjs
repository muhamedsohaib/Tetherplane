// Disposable CI fixture, not a user browser and not a production process.
// Holds one Node process long enough for bounded Windows CIM sampling.
// It never forks, touches credentials, opens sockets, or writes files.
setTimeout(() => {}, 8_000);

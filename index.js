#! /usr/bin/env node

const readline = require('readline');
const DenonClient = require('./lib/DenonClient');

const denon = new DenonClient();
const host = process.argv[2] || process.env.DENON_HOST;

function green(s) { return `\x1b[32m${s}\x1b[0m`; }
function red(s) { return `\x1b[31m${s}\x1b[0m`; }
function magenta(s) { return `\x1b[35m${s}\x1b[0m`; }
function dim(s) { return `\x1b[2m${s}\x1b[0m`; }

function getSurroundMode(val) {
  const alias = {
    mstereo: 'MCH STEREO', dolby: 'DOLBY DIGITAL',
    dts: 'DTS SURROUND', rock: 'ROCK ARENA', jazz: 'JAZZ CLUB',
  };
  return (alias[val] || val).toUpperCase();
}

function range(num, min, max) {
  return Math.max(Math.min(num, max), min);
}

const commands = {
  help: {
    desc: 'Show this help',
    run() {
      console.log('\nAvailable commands:');
      const aliases = { v: 'volume', i: 'input', m: 'mode', q: 'quit', exit: 'quit' };
      const aliasMap = {};
      for (const [alias, target] of Object.entries(aliases)) {
        if (!aliasMap[target]) aliasMap[target] = [];
        aliasMap[target].push(alias);
      }
      for (const [name, cmd] of Object.entries(commands)) {
        if (aliases[name]) continue; // skip alias entries
        const aliasSuffix = aliasMap[name] ? ` (${aliasMap[name].join(', ')})` : '';
        const label = `${name}${aliasSuffix}`;
        console.log(`  ${label.padEnd(20)} ${dim(cmd.desc)}`);
      }
      console.log(`  ${'<raw command>'.padEnd(20)} ${dim('Send any raw telnet command (e.g. PWON, SI?, MV50)')}`);
      console.log();
    },
  },
  on:       { desc: 'Power on',            run: () => denon.command('PWON') },
  off:      { desc: 'Power standby',       run: () => denon.command('PWSTANDBY') },
  play:     { desc: 'Play',                run: () => denon.command('NS9A') },
  pause:    { desc: 'Pause',               run: () => denon.command('NS9B') },
  stop:     { desc: 'Stop',                run: () => denon.command('NS9C') },
  next:     { desc: 'Next track',          run: () => denon.command('NS9D') },
  prev:     { desc: 'Previous track',      run: () => denon.command('NS9E') },
  mute:     { desc: 'Query mute state',     run: () => denon.command('MU?') },
  bluetooth:{ desc: 'Switch to Bluetooth',  run: () => denon.command('SIBT') },
  btpair:   { desc: 'Bluetooth pairing mode (same as bluetooth)', run: () => denon.command('SIBT') },
  status:   { desc: 'Query all status',    run() {
    denon.command('PW?');
    setTimeout(() => denon.command('MV?'), 100);
    setTimeout(() => denon.command('MU?'), 200);
    setTimeout(() => denon.command('SI?'), 300);
    setTimeout(() => denon.command('MS?'), 400);
  }},
  'volume': {
    desc: 'Volume [level 0-98] or ? to query',
    run(args) {
      let arg = '?';
      if (args[0] != null && args[0] !== '') {
        if (args[0] === '?') {
          arg = '?';
        } else {
          const vol = parseInt(args[0], 10);
          if (Number.isNaN(vol)) {
            console.error(red('Invalid volume: please provide a number between 0 and 98.'));
            return;
          }
          arg = range(vol, 0, 98);
        }
      }
      denon.command(`MV${arg}`);
    },
  },
  'input': {
    desc: 'Input source [bt/cd/tuner/usb/net/aux1/spotify/...] or ? to query',
    run(args) {
      denon.command(`SI${args[0] ? args[0].toUpperCase() : '?'}`);
    },
  },
  'mode': {
    desc: 'Surround mode [stereo/direct/music/movie/game/dolby/dts/rock/jazz/...]',
    run(args) {
      denon.command(`MS${args[0] ? getSurroundMode(args[0]) : '?'}`);
    },
  },
  quit:     { desc: 'Exit', run() { denon.end(); process.exit(0); } },
};

commands.v = commands.volume;
commands.i = commands.input;
commands.m = commands.mode;
commands.q = commands.quit;
commands.exit = commands.quit;

// --- Events ---

denon.on('connect', () => {
  const addr = denon.socket.remoteAddress;
  const port = denon.socket.remotePort;
  console.log(green(`Connected to ${addr}:${port}`));
});

denon.on('error', err => {
  console.error(red('Error:'), err.message);
  denon.end();
});

denon.on('close', () => {
  console.log(red('Connection closed'));
});

denon.on('data', buffer => {
  const lines = buffer.toString().trim().split('\r');
  for (const line of lines) {
    if (line.trim()) console.log(magenta(line.trim()));
  }
});

// --- Start ---

if (!host) {
  console.log(red('Usage: denon <host-ip>'));
  console.log(red('  or set DENON_HOST environment variable'));
  process.exit(1);
}

console.log(`Connecting to ${host}...`);
denon.connect(host).then(() => {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'denon$ ',
  });

  rl.prompt();

  rl.on('line', line => {
    const parts = line.trim().split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1);

    if (!cmd) {
      rl.prompt();
      return;
    }

    if (commands[cmd]) {
      commands[cmd].run(args);
    } else {
      // Send as raw command
      denon.command(line.trim());
    }

    rl.prompt();
  });

  rl.on('close', () => {
    denon.end();
    process.exit(0);
  });
}).catch(err => {
  console.error(red(`Failed to connect: ${err.message}`));
  process.exit(1);
});

// Fails if a Moonetix secret, or the start of one, ended up in the built files in dist/.
import fs from 'node:fs';
import path from 'node:path';

try {
  process.loadEnvFile('.env');
} catch {
  // use the environment as is
}

const secrets = ['MOONETIX_LINK_SALT', 'MOONETIX_POSTBACK_KEY']
  .map((name) => [name, process.env[name]])
  .filter(([, value]) => value && value.length >= 8);
if (secrets.length === 0) {
  console.error('Set MOONETIX_LINK_SALT and MOONETIX_POSTBACK_KEY (in .env or the environment) to check the bundle.');
  process.exit(2);
}
if (!fs.existsSync('dist')) {
  console.error('dist/ not found. Run npm run build first.');
  process.exit(2);
}

const files = fs.readdirSync('dist', { recursive: true }).map((f) => path.join('dist', String(f))).filter((f) => fs.statSync(f).isFile());
let leaks = 0;
for (const file of files) {
  const text = fs.readFileSync(file, 'latin1');
  for (const [name, value] of secrets) {
    if (text.includes(value.slice(0, 8)) || text.includes(name)) {
      console.error(`${file} contains ${name} or its first characters.`);
      leaks++;
    }
  }
}
console.log(`Checked ${files.length} files in dist/: ${leaks === 0 ? 'no secrets found' : leaks + ' problem(s)'}.`);
process.exit(leaks === 0 ? 0 : 1);

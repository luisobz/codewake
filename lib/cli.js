import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const DEFAULT_PROMPT = 'Continúa con la tarea pendiente. Primero revisa el estado actual, los cambios sin confirmar y las pruebas. Trabaja de forma autónoma hasta completar el siguiente objetivo lógico.';
const STATE_DIR = process.env.CLAUDE_RESUME_STATE_DIR || resolve(homedir(), '.local/state/claude-resume');
const SELF = fileURLToPath(import.meta.url);

export function usage() {
  return `Uso:
  claude-resume <id-sesion> -h <horas> -m <minutos> [opciones]
  claude-resume list
  claude-resume cancel <id-trabajo>

Opciones:
  -h, --hours <n>       Horas de espera (por defecto: 0)
  -m, --minutes <n>     Minutos de espera (por defecto: 0)
  -p, --project <ruta>  Directorio del proyecto (por defecto: directorio actual)
      --prompt <texto>  Prompt que se enviará al reanudar
      --claude-bin <p>  Ruta a claude (por defecto: CLAUDE_BIN o PATH)
      --dry-run         Muestra el comando sin programarlo
  --help                Muestra esta ayuda

Ejemplo:
  claude-resume 550e8400-e29b-41d4-a716-446655440000 -h 2 -m 28`;
}

function numeric(value, name) {
  if (!/^[0-9]+$/.test(value ?? '')) throw new Error(`${name} debe ser un entero positivo o cero.`);
  return Number(value);
}

export function parseArgs(argv) {
  if (!argv.length || argv.includes('--help')) return { command: 'help' };
  if (argv[0] === 'list') return { command: 'list' };
  if (argv[0] === 'cancel') return { command: 'cancel', jobId: argv[1] };
  if (argv[0] === '--run') return { command: 'run', jobId: argv[1] };

  const session = argv[0];
  if (!session || session.startsWith('-')) throw new Error('Indica un id o nombre de sesión válido.');
  const result = { command: 'schedule', session, hours: 0, minutes: 0, project: process.cwd(), prompt: DEFAULT_PROMPT, claudeBin: process.env.CLAUDE_BIN, dryRun: false };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--hours') result.hours = numeric(argv[++i], 'Las horas');
    else if (arg === '-m' || arg === '--minutes') result.minutes = numeric(argv[++i], 'Los minutos');
    else if (arg === '-p' || arg === '--project') result.project = resolve(argv[++i] ?? '');
    else if (arg === '--prompt') result.prompt = argv[++i] ?? '';
    else if (arg === '--claude-bin') result.claudeBin = argv[++i] ?? '';
    else if (arg === '--dry-run') result.dryRun = true;
    else throw new Error(`Opción desconocida: ${arg}`);
  }
  if (result.hours === 0 && result.minutes === 0) throw new Error('La espera debe ser mayor que cero.');
  if (result.minutes > 59) throw new Error('Los minutos deben estar entre 0 y 59.');
  if (!result.prompt.trim()) throw new Error('El prompt no puede estar vacío.');
  return result;
}

function findExecutable(command) {
  if (command && existsSync(command)) return resolve(command);
  const probe = spawnSync("which", [command || "claude"], { encoding: "utf8" });
  const found = probe.status === 0 ? probe.stdout.trim() : '';
  if (!found) throw new Error('No encuentro el ejecutable `claude`. Añádelo al PATH o usa --claude-bin /ruta/a/claude.');
  return found;
}

function jobPath(jobId) { return resolve(STATE_DIR, `${jobId}.json`); }
function ensureStateDir() { mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 }); }
function unitName(jobId) { return `claude-resume-${jobId}`; }
function makeJobId() { return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }

function systemdRun(args) {
  const result = spawnSync('systemd-run', args, { encoding: 'utf8' });
  if (result.error) throw new Error(`No se pudo ejecutar systemd-run: ${result.error.message}`);
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'systemd-run falló.').trim());
}

export function schedule(options) {
  if (!existsSync(options.project)) throw new Error(`El proyecto no existe: ${options.project}`);
  const claudeBin = findExecutable(options.claudeBin);
  const jobId = makeJobId();
  const delay = `${options.hours}h ${options.minutes}m 0s`;
  const job = { jobId, session: options.session, project: options.project, prompt: options.prompt, claudeBin, createdAt: new Date().toISOString(), delay };
  const command = ['--user', `--unit=${unitName(jobId)}`, `--on-active=${delay}`, '--collect', '--quiet', process.execPath, SELF, '--run', jobId];
  if (options.dryRun) return { job, command: ['systemd-run', ...command] };
  ensureStateDir();
  writeFileSync(jobPath(jobId), JSON.stringify(job, null, 2), { mode: 0o600 });
  try { systemdRun(command); }
  catch (error) { rmSync(jobPath(jobId), { force: true }); throw error; }
  return { job, command: ['systemd-run', ...command] };
}

export function runJob(jobId) {
  const path = jobPath(jobId);
  if (!jobId || !existsSync(path)) throw new Error(`No existe el trabajo ${jobId}.`);
  const job = JSON.parse(readFileSync(path, 'utf8'));
  console.log(`[claude-resume] Reanudando ${job.session} en ${job.project}`);
  const child = spawn(job.claudeBin, ['--resume', job.session, '--dangerously-skip-permissions', '-p', job.prompt], { cwd: job.project, stdio: 'inherit' });
  child.on('error', (error) => console.error(`[claude-resume] No se pudo iniciar Claude: ${error.message}`));
  child.on('exit', (code, signal) => {
    console.log(`[claude-resume] Claude terminó${signal ? ` por señal ${signal}` : ` con código ${code}`}.`);
    rmSync(path, { force: true });
    process.exitCode = code ?? 1;
  });
}

export function listJobs() {
  if (!existsSync(STATE_DIR)) return [];
  return readdirSync(STATE_DIR).filter((file) => file.endsWith('.json')).map((file) => JSON.parse(readFileSync(resolve(STATE_DIR, file), 'utf8')));
}

export function cancelJob(jobId) {
  if (!jobId || !/^[a-zA-Z0-9-]+$/.test(jobId)) throw new Error('Indica un id de trabajo válido.');
  const path = jobPath(jobId);
  if (!existsSync(path)) throw new Error(`No existe el trabajo ${jobId}.`);
  // Stop the queued transient timer before its service starts.
  const result = spawnSync("systemctl", ["--user", "stop", `${unitName(jobId)}.timer`], { encoding: "utf8" });
  if (result.status !== 0) throw new Error((result.stderr || 'No se pudo cancelar el temporizador.').trim());
  rmSync(path, { force: true });
}

export async function main(argv) {
  const args = parseArgs(argv);
  if (args.command === 'help') return console.log(usage());
  if (args.command === 'run') return runJob(args.jobId);
  if (args.command === 'list') {
    const jobs = listJobs();
    if (!jobs.length) return console.log('No hay reanudaciones programadas.');
    for (const job of jobs) console.log(`${job.jobId}\t${job.delay}\t${job.session}\t${job.project}`);
    return;
  }
  if (args.command === 'cancel') { cancelJob(args.jobId); return console.log(`Cancelado: ${args.jobId}`); }
  const { job, command } = schedule(args);
  if (args.dryRun) return console.log(command.map((part) => JSON.stringify(part)).join(' '));
  console.log(`Programado ${job.jobId}: sesión ${job.session} dentro de ${job.delay}.`);
  console.log(`Consulta: claude-resume list   |   Cancela: claude-resume cancel ${job.jobId}`);
}

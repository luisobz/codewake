# claude-resume-timer

Programa la reanudación automática de una sesión de [Claude Code](https://code.claude.com/) tras una espera. Está pensada para el caso de límite de uso: Claude se detiene, programas el momento aproximado del reset y la herramienta lanza Claude de nuevo con el mismo identificador de sesión.

Funciona en Linux con `systemd --user`, Node.js 18+ y el ejecutable `claude` instalado y autenticado. No necesita servidor, cuenta externa ni dependencias npm.

## Instalación

Cuando esté publicado:

```bash
npm install --global claude-resume-timer
```

Durante desarrollo, desde este repositorio:

```bash
npm link
```

Comprueba que tanto Claude como el temporizador de usuario están disponibles:

```bash
claude --version
systemctl --user status
```

## Uso

Nombra la conversación antes de dejarla, o usa su UUID. Dentro de Claude Code:

```text
/rename refactor-api
```

Después programa la reanudación desde el directorio del proyecto:

```bash
claude-resume refactor-api -h 2 -m 28
```

Al vencer el temporizador, se ejecuta exactamente:

```bash
claude --resume refactor-api --dangerously-skip-permissions -p 'Continúa con la tarea pendiente...'
```

El directorio de trabajo es el directorio desde el que se invocó `claude-resume`. Puedes indicarlo explícitamente y cambiar el prompt:

```bash
claude-resume refactor-api -h 2 -m 28 \
  --project ~/Proyectos/mi-app \
  --prompt 'Lee TASK_STATE.md, revisa git diff y termina la implementación. Ejecuta los tests.'
```

Para ver o cancelar trabajos:

```bash
claude-resume list
claude-resume cancel 1752660000000-ab12cd
```

Usa `--dry-run` para revisar el comando de `systemd-run` sin crear el timer:

```bash
claude-resume refactor-api -h 2 -m 28 --dry-run
```

Los trabajos pendientes se guardan, con permisos de usuario, en `~/.local/state/claude-resume/`.

## Funcionamiento

`systemd-run --user --on-active=…` crea un temporizador temporal. Cuando vence, vuelve a ejecutar este paquete internamente y éste inicia Claude en modo de impresión (`-p`) sobre la sesión indicada. El transcript de Claude Code se conserva; no se crea una conversación nueva.

El uso de nombre de sesión es cómodo, pero para no equivocarte entre sesiones con el mismo nombre es preferible usar el UUID mostrado por Claude Code. Puedes reanudar una sesión por nombre o identificador con `claude --resume` según la documentación oficial de Claude Code.

## Importante: ejecución autónoma

La herramienta usa `--dangerously-skip-permissions` porque se ha solicitado explícitamente una continuación sin intervención. Esa opción permite a Claude ejecutar acciones y editar archivos sin pedir confirmación.

Programa únicamente sesiones y repositorios que confíes, revisa el prompt antes de programarlo y mantén copias de seguridad o control de versiones. No ejecutes esta herramienta con `sudo`.

El usuario de `systemd` debe permanecer activo para que el timer pueda correr. Si el equipo cierra por completo la sesión de usuario al salir, habilita el *linger* una vez:

```bash
loginctl enable-linger "$USER"
```

No hace falta para dejar el equipo encendido con la sesión gráfica normal.

## Publicar en npm

Antes de publicar, sustituye las URLs `REPLACE_WITH_YOUR_USER` de `package.json`, crea el repositorio Git y elige un nombre npm que esté libre. Si `claude-resume-timer` ya existe, usa un paquete con scope, por ejemplo `@tu-usuario/claude-resume`.

```bash
npm test
npm pack --dry-run
npm login
npm publish --access public
```

Para un paquete con scope, cambia `name` a `@tu-usuario/claude-resume`; el binario seguirá llamándose `claude-resume`.

## Desarrollo

```bash
npm test
node bin/claude-resume.js --help
```

No hay dependencias de producción. Las pruebas cubren el análisis de argumentos; el timer real debe comprobarse en una máquina Linux con una sesión `systemd --user` activa.

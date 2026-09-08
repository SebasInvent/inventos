# Reconciliación tras reimagen — implementación local

Plan: `/Users/Apple/.codex/artifacts/skynet-auditoria-astra-2026-09-07/journey-parque/PLAN-RECONCILIACION-INSTALADOR.md`, J-02. Base revisada `origin/main` 6c601fb, cero PR abiertos el 8-sep-2026. No se tocó ningún VPS ni se publicó esta rama.

## Contrato

El CLI de InventOS y CódigoEnigma expone `snapshot-target`, `inspect-target` y `reconcile-target`, con `--json` como única opción. El contrato entra por stdin (máximo 64 KiB). No acepta rutas, `force`, contraseñas ni shell. Target normalizado `{host,user,port}`; ciclo, entorno e instancia son identificadores restringidos. El target del registro sigue siendo `root@IP:22`; las lecturas pueden usar `ubuntu` + `sudo -n` cuando la imagen nueva no permite root todavía. Ambos fallos significan desconocido.

Base: `{schemaVersion:1,cycleId,entornoId,instanceId,target}`. Snapshot devuelve `{ok:true,snapshot:{...base,registry:{sha256,revision},previousMachine:{machineIdHash,machineIdMtime}}}` y persiste el mismo objeto privadamente antes de reinstalar. No acepta fotografías inventadas por el siguiente comando. Un snapshot sin identidad anterior no está soportado en v1 y bloquea.

Inspect devuelve `{ok:true,observation:{machineIdHash,machineIdMtime,ip,services,containers,volumes,dockerPresent,dataDirectoriesAbsent}}`. La sonda comprueba códigos de salida de todas las lecturas Docker, y ausencia de `/var/lib/docker`, `/var/lib/containerd` si Docker falta. Siempre mide `/opt/inventos`. No cambia Docker ni borra stacks. `machineIdHash` es SHA256 del machine-id sin salto de línea; mtime de Linux viene en segundos y se serializa ISO UTC. La comparación con `receipt.reinstalledAt` rechaza sólo **anterior** y permite igualdad exacta, conforme a `verificarLimpieza` vigente en SkyNet; no se redondea el ancla. El primer motor usó `<=` por un supuesto incorrecto: la prueba de igualdad fue roja y se corrigió a `<` tras cotejar la guarda canónica con el integrador. Hay casos separados para igualdad exacta y ancla 1 ms posterior.

Reconcile recibe `{...base,snapshot,receipt:{...base,machineIdHash,machineIdMtime,reinstalledAt}}`; devuelve `{ok:true,reconciliation:{...base,machineIdHash,machineIdMtime,sourceHash,archiveHash,revision}}`. Ambos hashes coinciden (o ambos null si ausente); revisión = `(snapshot.registry.revision ?? 0)+1`. Exige coincidencia exacta con snapshot privado, recibo, generación medida y CAS. Archiva todos los stacks, incluyendo desconocidos para la receta. Diario sincronizado a disco permite recuperar muerte del proceso tras rename. Replay rechaza un nuevo propietario.

## Lock y propiedad

SQLite nativo `BEGIN IMMEDIATE` por target excluye tanto el apply **completo** como snapshot, inspect y reconciliación. El SO libera el lock al morir el proceso; no hay borrado automático de un lock por reloj. `assertStackOwnership` sólo escribe dentro del contexto del lock. Registros versionados llevan target, instancia, generación, revisión, organización, trabajo y propietarios. Registros corruptos, ilegibles o enlaces simbólicos fallan; sólo ENOENT es ausencia. Se revisan también los ancestros y sidecars SQLite. Un administrador root o el mismo UID que altera activamente la carpeta queda fuera del modelo de amenaza.

`apply` acepta orgId/workId/instanceId del integrador y verifica propiedad antes de leer o escribir secretos. Los secretos de organizaciones nuevas usan namespace por orgId. Un registro legado con organización nueva requiere limpieza canónica o migración revisada; nunca se reasigna por compartir slug.

## Validación

RED: prueba nueva referenció el módulo de reconciliación inexistente, salida 1, 0 pasadas/1 fallida. Commit `36feb4c`. Después, pruebas de filesystem, controles positivos, subprocesses y shell verificaron casos individuales. El primer ensayo de lock de proceso falló porque la promesa sin handles dejaba morir al proceso de control; se corrigió el control con un handle activo. Esto no fue un fallo del lock medido después.

Comandos: `node --test tests/*.test.mjs`, `node --experimental-test-coverage --test tests/*.test.mjs`, y build CLI esbuild. `mutations.json` conserva mutantes individuales, cada uno ejecutado sobre la suite y restaurado inmediatamente. La cobertura focal del módulo nuevo supera 80%; no se presenta como cobertura de todo el instalador histórico.

## Rollout pendiente

Requiere **Node.js >=24 con `node:sqlite`** en el coordinador; Node24 sólo está verificado localmente. El comando emite error explícito en runtime menor antes de tocar filesystem. No se habilita automáticamente ni se presume compatibilidad remota. Publicar motor, fijar su commit en empaquetador y probar tarball, desplegar API/worker juntos y realizar un ensayo con servidor libre autorizado siguen siendo gates externos. No hay prueba contra proveedor/VPS ni afirmación de producción o del recorrido integral.

## Corrección de integración: mapas JSON y confianza SSH por ciclo

La revisión contra SkyNet encontró dos defectos del primer candidato: una recarga de Firestore
puede cambiar el orden de claves JSON y el motor comparaba su serialización; además, una reimagen
cambia la clave SSH y el inspector no tenía una confianza nueva acotada. Ambas reproducciones
fueron rojas (2 fallidas, 0 pasadas) antes del fix, commit f20e453.

La igualdad usa `isDeepStrictEqual`, mientras el CAS y el hash del archivo original siguen siendo
byte-exactos. `inspect-target` ahora requiere `{...base,authorization:{...base,reinstalledAt}}`,
con el sello durable de autorización PUT que devuelve SkyNet. `reconcile-target` usa su receipt
con ese mismo sello. El motor exige snapshot previo y guarda autorización inmutable por ciclo.

El snapshot previo usa `StrictHostKeyChecking=yes`. Sólo inspect/reconcile autorizados usan
`accept-new`, un `known_hosts` privado 0600 dentro del ciclo, `GlobalKnownHostsFile=/dev/null`
y `UpdateHostKeys=no`. No hay `StrictHostKeyChecking=no`, escritura ni borrado de archivos globales.
Root y el fallback ubuntu comparten la misma huella privada. Tras observar la generación nueva,
se sella generación/hash de known_hosts y cualquier cambio posterior falla cerrado. Un primer
sondeo que aún observa la generación anterior no sella confianza; descarta sólo su archivo
privado provisional para permitir que el siguiente sondeo vea la clave de la reimagen real.
Un archivo corrupto no se interpreta como ausencia ni se limpia para seguir.

Prueba nueva con **OpenSSH real**: sshd sólo loopback, puerto efímero, llaves de prueba, ssh-agent
independiente, conexión/rotación de hostkey reales. Demuestra rechazo inicial strict, autorización,
sondeo de generación anterior, pin de nueva generación, replay con mapas reordenados, rechazo de
clave cambiada, aislamiento entre ciclos y corrupción. Otra prueba captura argv de procesos SSH
reales con un doble ejecutable y verifica política, ruta privada, root/ubuntu y cero conexión al
cambiar autorización. Se mataron por separado los mutantes de JSON.stringify y StrictHostKeyChecking=no;
ver `ssh-mutations.json`. No se conectó a VPS ni se modificó configuración SSH global.

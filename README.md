# VLSM Lab

Aplicación educativa ClassVirtual VLSM Lab, integrada con el LMS AulaSimple: el alumno entra desde la tarjeta de la app en la plataforma o con el mismo correo y contraseña que usa allí.

## Incluye
- Branding ClassVirtual
- Dashboard principal
- 6 niveles
- 26 actividades totales
- Nivel 1: Fundamentos
- Nivel 2: VLSM en acción
- Nivel 3: VLSM avanzado
- Nivel 4: Laboratorio con topología interactiva
- Nivel 5: Troubleshooting
- Nivel 6: Reto profesional
- Validación matemática
- Explicaciones y pistas pedagógicas
- Seguimiento de habilidades
- “Practicar mis errores”
- Progreso por nivel y progreso global
- Progreso de cada alumno guardado en el servidor (SQLite)
- Interfaz responsive

## Acceso
- **Desde la tarjeta del LMS**: la plataforma abre la app con `?lmsToken=`. El servidor lo canjea con `LMS_URL/api/access/exchange-token` y abre la sesión. Ese token manda sobre cualquier sesión que ya estuviera abierta en el navegador.
- **Con correo y contraseña**: se validan contra el LMS (`/api/access/login`). La app no guarda contraseñas.
- **Administrador de prueba**: el correo de `APP_ADMIN_EMAIL` entra con `APP_ADMIN_PASSWORD` sin consultar al LMS. Si esas variables están vacías, no existe.
- La app no crea cuentas ni recupera contraseñas: eso se hace en la plataforma.
- El correo, normalizado en minúsculas, identifica al usuario: se entre por donde se entre, se ve el mismo progreso.

## Estructura
- `public/`: la interfaz (`index.html` y `assets/`).
- `server/`: servidor Express. `auth.js` (SSO, login, sesiones), `progress.js` (progreso por usuario), `db.js` (SQLite con migraciones automáticas).
- `tests/sso.test.mjs`: levanta un LMS simulado y comprueba SSO, login, administrador de prueba, que se vea lo mismo por las dos puertas y que los datos sigan ahí tras reiniciar.

## Cómo correrla localmente
1. `npm install`
2. Copia `.env.example` a `.env` y completa las variables.
3. `npm run dev` y abre `http://localhost:3000`.
4. `npm test` ejecuta las pruebas.

## Despliegue en EasyPanel
- Crea un servicio App desde este directorio: el `Dockerfile` ya está listo y expone el puerto 3000.
- Configura `LMS_URL`, `APP_SLUG` y, si quieres, `APP_ADMIN_EMAIL` y `APP_ADMIN_PASSWORD`.
- Monta un volumen en `/app/data`. **Sin volumen, cada redespliegue borra la base** y no aparece ningún error.
- Pide al administrador del LMS que registre la app en `/admin/apps` con el mismo slug y la URL pública del servicio.
- Para respaldar, copia el volumen completo, incluidos `app.db-wal` y `app.db-shm`.


## V2 UX
- Paso 1 de 5 visible en laboratorio
- Botón contextual: Comprobar LAN A/B/C/D/WAN
- Avance automático tras respuesta correcta
- Mensaje pedagógico breve antes de avanzar
- Pantalla final con tabla completa de direccionamiento


## Corrección de navegación V4
- Nivel 4 completo -> Nivel 5 directamente.
- El botón Siguiente del Nivel 4 nunca abre Mi progreso.
- La pantalla final del laboratorio oculta la navegación inferior ambigua.
- CTA explícito: “Ir al Nivel 5 · Troubleshooting”.
- Mi progreso solo se abre automáticamente al terminar el Nivel 6.

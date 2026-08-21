# MCP Chat Host

Un chatbot que se conecta a varios servidores de Model Context Protocol al mismo tiempo y permite
que un modelo de lenguaje use sus herramientas. Dos servidores oficiales (Filesystem y Git) y uno
desarrollado para este proyecto (una mesa de servicio de un proveedor de internet) que se ejecuta
tanto de forma local como desplegado en la nube.

Universidad del Valle de Guatemala, CC3067 Redes, Proyecto 1.

El protocolo MCP está implementado a mano. No se utiliza ningún SDK de MCP: el formato de las tramas
JSON-RPC, el ciclo de inicialización, la negociación de versión, el transporte stdio y el transporte
Streamable HTTP se escribieron desde cero, tanto del lado del cliente como del servidor.

## Requisitos

- Node.js 20 o superior
- uv (el servidor oficial de Git es un paquete de Python que se ejecuta con uvx)
- Git
- Una llave de API de OpenRouter, gratuita en https://openrouter.ai/keys

Wireshark con Npcap solo hace falta para reproducir las capturas de paquetes.

## Instalación

    git clone https://github.com/UVG-Work/Proyecto-1-Chat-MCP-.git
    cd Proyecto-1-Chat-MCP-
    npm install
    npm install --prefix web

Copie el archivo de ejemplo de variables de entorno y agregue su llave:

    cp .env.example .env

Defina al menos estos dos valores en `.env`:

    OPENROUTER_API_KEY=sk-or-v1-...
    OPENROUTER_MODEL=nvidia/nemotron-3-super-120b-a12b:free

El modelo debe soportar llamadas a herramientas. Para listar los modelos que lo hacen:

    curl -s "https://openrouter.ai/api/v1/models?supported_parameters=tools"

Un modelo sin soporte de herramientas responde preguntas normales pero nunca llama a una
herramienta, lo cual parece un error del cliente. Revise esto primero si las herramientas se están
ignorando.

Prepare el entorno de prueba que usan los servidores de Filesystem y Git:

    npm run setup:demo

## Ejecución

Chatbot en terminal:

    npm run cli

Chatbot web, en dos terminales:

    npm run api
    npm run web

Luego abra http://localhost:5173

## Comandos de la terminal

Dentro de `npm run cli`:

    /servers        servidores conectados, transportes y versiones negociadas
    /tools          el catálogo de herramientas tal como lo recibe el modelo
    /log [n]        las últimas n tramas MCP, 40 por omisión
    /log full       cada trama con su carga JSON completa
    /log <servidor> tramas de un solo servidor
    /stats          conteo de tramas por tipo de mensaje
    /reset          limpia el contexto de la conversación
    /exit           salir

## Otros comandos

Comprobar que la capa MCP funciona sin usar el modelo de lenguaje:

    npm run probe                       todos los servidores habilitados
    npm run probe -- git                solo los servidores que coincidan con un nombre
    npm run demo:session -- noc-local   una sesión MCP completa sobre stdio
    npm run demo:session -- noc-remote  la misma sesión contra el despliegue remoto

Ejecutar una demostración guionizada:

    npm run demo:chat -- --scenario context     API del modelo y contexto de sesión
    npm run demo:chat -- --scenario git         servidores de Filesystem y Git
    npm run demo:chat -- --scenario noc         el servidor NOC propio
    npm run demo:chat -- --scenario outage      la ruta de avería de zona
    npm run demo:chat -- --scenario suspended   la ruta de cuenta suspendida

Agregue `--log` a cualquier escenario para imprimir después el registro completo de tramas MCP.

Ejecutar el servidor propio por separado:

    npm run noc:stdio    transporte stdio
    npm run noc:http     Streamable HTTP en http://127.0.0.1:8787/mcp

## Selección de servidores

`config/servers.json` lista los servidores a los que se conecta el anfitrión. Poner `enabled` en
false omite una entrada sin borrarla.

Para usar el servidor propio de forma local, habilite `noc-local` y deshabilite `noc-remote`. Para
usar el desplegado, haga lo contrario y defina `NOC_REMOTE_URL` en `.env`. Nada más cambia: el mismo
código de servidor atiende ambos casos.

## El servidor propio

Una mesa de servicio de un proveedor de internet, con cinco herramientas:

    lookup_subscriber      busca una cuenta por nombre, identificador, circuito o teléfono
    get_link_metrics       latencia, jitter, pérdida de paquetes, SNR y throughput
    run_link_diagnostics   evalúa la telemetría y devuelve un diagnóstico
    check_zone_outage      incidentes conocidos que afectan una zona de servicio
    open_incident_ticket   escala el caso creando un ticket

Todos los datos son sintéticos. La especificación completa está en `docs/server-spec.md`.

Ejemplo: pídale al chatbot "La clienta Maria Elena Ramirez dice que su internet esta muy lento.
Investiga y abre un ticket si corresponde." Llama a las cinco herramientas en orden y reporta el
número de ticket.

## Despliegue del servidor

El repositorio incluye un Dockerfile y un blueprint de Render. Cree un Web Service en Render
apuntando a este repositorio, espere a que compile y verifíquelo:

    curl https://su-servicio.onrender.com/health

Coloque la URL en `.env` como `NOC_REMOTE_URL=https://su-servicio.onrender.com/mcp`, habilite
`noc-remote` en `config/servers.json` y verifique con `npm run probe -- noc-remote`.

El plan gratuito suspende el servicio cuando está inactivo, por lo que la primera petición tras una
pausa tarda alrededor de 50 segundos.

## Capturas de paquetes

Captura en texto plano sobre loopback:

    powershell -ExecutionPolicy Bypass -File scripts/capture-loopback.ps1

Captura cifrada contra el despliegue, con exportación de llaves TLS para que Wireshark pueda
descifrarla:

    powershell -ExecutionPolicy Bypass -File scripts/capture-remote.ps1

Ambas escriben en `docs/captures/`. Para la cifrada, indique el archivo de llaves en Wireshark bajo
Preferences, Protocols, TLS, (Pre)-Master-Secret log filename.

## Estructura del proyecto

    src/mcp/         el protocolo: tipos, tramas, transportes, cliente y registro de interacciones
    src/server/      el servidor NOC propio y sus dos puntos de entrada
    src/host/        el anfitrión: configuración, enrutamiento de herramientas, conversación, modelo
    src/cli/         chatbot de terminal y los ejecutables de prueba y demostración
    src/api/         puente HTTP para la interfaz web
    web/             chatbot en React
    docs/            especificación, análisis de protocolo, conclusiones y capturas
    config/          a qué servidores MCP conectarse

## Documentación

    docs/server-spec.md               especificación, parámetros y endpoints del servidor propio
    docs/wireshark-analysis.md        análisis de las capturas de paquetes, capa por capa
    docs/conclusions.md               conclusiones, dificultades y lecciones aprendidas
    docs/Proyecto1-Entrega-Parcial.pdf  documento de la entrega parcial

`README.en.md` contiene esta misma información en inglés.

## Notas

La herramienta `git_init` no existe en el servidor oficial de Git (versión 1.29.0), por lo que
`npm run setup:demo` crea el repositorio de demostración. Todo lo demás, es decir crear el README,
agregarlo al índice y hacer el commit, lo realiza el chatbot a través de MCP.

La prohibición de usar SDKs aplica únicamente a implementaciones de MCP. El paquete `openai` se
utiliza como un simple cliente HTTP hacia la API de OpenRouter; todo byte de MCP en este proyecto lo
produce código propio en `src/mcp/` y `src/server/`.

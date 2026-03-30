# The Intern

Un conjunto de configuraciones, ajustes de cuenta, limitaciones de permisos y agentes de IA para completar tareas de oficina.

## Funcionalidades

El asistente debe ser capaz de realizar las siguientes acciones:

- Correo electrónico: leer, resumir, redactar, sugerir respuestas.
- Búsqueda: encontrar información en una base de datos heterogénea (documentos locales, acceso web, acceso a bases de datos remotas).
- Consultor: brindar asesoramiento personalizado basado en áreas de experiencia entrenadas.
- Gestor de cuentas: administrador de perfiles en redes sociales (responder mensajes, crear nuevas publicaciones...).
- Traducción: Traducción de documentos del ambito legal, español, inglés, checo.

## Arquitectura

El enfoque de este proyecto será aprovechar agentes especializados y APIs remotas para las diferentes acciones.

### Agentes de IA

Este es el núcleo de la aplicación. Crearemos diferentes configuraciones y agentes ajustados para obtener las mejores respuestas posibles de los modelos de IA.

Qué queremos de los agentes:

- Proveedor: Usar más de un proveedor (Claude, GPT, LLM local).
- Modelo: Elegir el modelo dependiendo de la tarea.
- Contexto: Cada agente tiene su context dedicado.

### Contexto a medida

Queremos que los agentes puedan acceder a información relevante. 

- Casos, eventos importantes para el cliente (Moreno-Hartman o quien sea).
- Ateojeras (como los burros) que no se distraigan con datos irrelevantes para la tarea.

**Un concepto importante: Indexación Semántica (Vectorial para LLMs/Agentes RAG).**

### Interfaces con el mundo real

Los agentes deben poder acceder a datos y APIs para poder llevar a cabo sus tareas. Esos interfaces deberan ser:

- Accesibles programaticamente: REST APIs, aplicaciones de terminal...
- Observables: debe ser posible monitorizar lo que el agente hace en todo momento.
- Interceptables: debemos poder para al agente si va a llevar a cabo algo ilegal (ilegal para nuestro caso, no literalmente ilegal).

### Herramientas

Una lista de las herramientas o componentes que tenemos disponibles para llevar a cabo nuestro proyecto:

- Contenedores: Docker, podman, máquinas virtuales o el propio ordenador físico limitado por configuración del sistema.
- Usuario de la red: cuentas de email, contraseñas, accesso a Dropbox u otras aplicaciones de la empresa.
- Agentes: Claude APIs, GPT, etc. LLMs locales.
- Orquestradoes: [Open Claw](https://openclaw.ai/), [Pi Agent](https://shittycodingagent.ai/)

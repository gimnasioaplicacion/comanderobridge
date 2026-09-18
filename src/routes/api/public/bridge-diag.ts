import { createFileRoute } from '@tanstack/react-router'

// Registro temporal de diagnóstico del agente de impresión.
// No devuelve datos ni muestra nada en pantalla: sólo deja constancia en el
// registro del servidor para poder analizarlo.
export const Route = createFileRoute('/api/public/bridge-diag')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const body = await request.text()
          console.log('[bridge-diag]', body.slice(0, 4000))
        } catch (e) {
          console.log('[bridge-diag] error', String(e))
        }
        return new Response('ok')
      },
    },
  },
})

// supabase/functions/server-time/index.ts
// Deploy: supabase functions deploy server-time --no-verify-jwt
//
// Retorna a data/hora atual do servidor para evitar que clientes
// manipulem o relógio local do dispositivo para burlar o bloqueio.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Cache-Control":                "no-store, no-cache, must-revalidate",
  "Content-Type":                 "application/json",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  const now = new Date();

  return new Response(
    JSON.stringify({
      iso:       now.toISOString(),           // ex: "2025-05-13T21:00:00.000Z"
      ts:        now.getTime(),               // Unix ms
      date_utc:  now.toISOString().slice(0, 10), // "2025-05-13"
      // Data local de Assunção (UTC-4) para conveniência
      date_py:   new Date(now.getTime() - 4 * 3600 * 1000)
                   .toISOString().slice(0, 10),
    }),
    { headers: CORS }
  );
});

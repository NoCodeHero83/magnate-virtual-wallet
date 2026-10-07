// supabase/functions/notification-worker/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
const WORKER_SECRET = Deno.env.get('WORKER_SECRET');

const supabase = createClient(SUPABASE_URL || '', SUPABASE_SERVICE_ROLE_KEY || '');

const QUEUE_NAME = 'notification_jobs';
const BATCH_SIZE = 10;
const VISIBILITY_TIMEOUT = 60;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-worker-secret',
};

// Los datos (nombre del usuario, motivos escritos por un admin, etc.) se escapan:
// no deben poder inyectar HTML ni links en un correo de Magnate.
function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Reemplaza {{variables}}. Las claves de `trustedHtml` se insertan sin escapar (las arma este worker).
// Las variables que no tienen valor se quitan para no mostrar "{{algo}}" en el correo.
function renderTemplate(template: string, data: Record<string, any>, trustedHtml: Record<string, string> = {}): string {
  let rendered = template;
  for (const [key, value] of Object.entries(data)) {
    rendered = rendered.replace(new RegExp(`{{${key}}}`, 'g'), escapeHtml(value));
  }
  for (const [key, value] of Object.entries(trustedHtml)) {
    rendered = rendered.replace(new RegExp(`{{${key}}}`, 'g'), value);
  }
  return rendered.replace(/{{\s*[a-zA-Z0-9_]+\s*}}/g, '');
}

const currency = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' });
const formatAmount = (value: unknown) => currency.format(Number(value) || 0);

// Datos derivados para los correos de transferencias: monto con formato, fecha y comisión
function enrichTransactionData(type: string, data: Record<string, any>) {
  const extra: Record<string, any> = {};
  const trusted: Record<string, string> = { commission_html: '' };
  if (data.amount !== undefined && data.amount_formatted === undefined) {
    extra.amount_formatted = formatAmount(data.amount);
  }
  if (data.date === undefined) {
    extra.date = new Date(data.created_at ?? Date.now()).toLocaleString('es-AR', {
      timeZone: 'America/Argentina/Buenos_Aires',
      dateStyle: 'short',
      timeStyle: 'short',
    });
  }
  const commission = Number(data.commission) || 0;
  if (commission > 0 && (type === 'transaction_sent' || type === 'transaction_received')) {
    const amount = Number(data.amount) || 0;
    const line = (label: string, value: number) =>
      `<p><strong>${label}:</strong> ${escapeHtml(formatAmount(value))}</p>`;
    trusted.commission_html = type === 'transaction_sent'
      ? line('Comisión', commission) + line('Total debitado', Number(data.total_debit) || amount + commission)
      : line('Comisión', commission) + line('Neto acreditado', amount - commission);
  }
  return { extra, trusted };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  console.log('🚀 Worker ejecutándose...');

  // ✅ VALIDACIÓN DE SEGURIDAD
  const workerSecret = req.headers.get('x-worker-secret');
  if (workerSecret !== WORKER_SECRET) {
    console.error('❌ Unauthorized access attempt');
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  try {
    const { data: messages, error: readError } = await supabase.rpc('read_queue_messages', {
      p_queue_name: QUEUE_NAME,
      p_vt: VISIBILITY_TIMEOUT,
      p_qty: BATCH_SIZE
    });

    if (readError) {
      console.error('❌ Error leyendo cola:', readError);
      throw readError;
    }

    if (!messages || messages.length === 0) {
      return new Response(JSON.stringify({ processed: 0, message: 'No messages in queue' }), { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      });
    }

    console.log(`📨 Procesando ${messages.length} mensajes...`);

    const results = {
      processed: 0,
      sent_push: 0,
      sent_email: 0,
      failed: 0,
      errors: [] as string[]
    };

    for (const queueMsg of messages) {
      try {
        const msg = queueMsg.message;
        console.log(`📤 Procesando: ${msg.notification_type} para ${msg.user_id || msg.data?.email}`);

        // 👤 Obtener datos del usuario (si existe)
        let user = null;
        if (msg.user_id) {
          const { data } = await supabase.from('users').select('email, first_name').eq('id', msg.user_id).single();
          user = data;
        }

        const targetEmail = user?.email || msg.data?.email;
        const targetName = user?.first_name || msg.data?.first_name || 'Usuario';

        // 📋 Obtener template
        const { data: notifType } = await supabase.from('notification_types').select('*').eq('code', msg.notification_type).single();

        if (!notifType) {
          throw new Error(`Template not found: ${msg.notification_type}`);
        }

        const title = notifType.template_title?.es || 'Notificación Magnate';
        const body = notifType.template_message?.es || '';

        // --- 📧 ENVÍO EMAIL ---
        if (targetEmail && RESEND_API_KEY && notifType.email_template_html) {
          console.log(`📧 Enviando email a ${targetEmail}...`);
          
          const { extra, trusted } = enrichTransactionData(msg.notification_type, msg.data ?? {});
          const { title: _t, message: _m, ...data } = (msg.data ?? {}) as Record<string, any>;
          const templateData = { first_name: targetName, ...data, ...extra };
          // title y message vienen de la BD; message también lleva {{variables}}
          const emailHtml = renderTemplate(notifType.email_template_html.es, templateData, {
            ...trusted,
            title: escapeHtml(title),
            message: renderTemplate(escapeHtml(body), templateData),
          });
          const emailSubject = msg.notification_type === 'email_verification' ? '🔐 Verifica tu cuenta - Magnate' : title;

          const resendResponse = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${RESEND_API_KEY}`
            },
            body: JSON.stringify({
              from: 'Magnate <no-reply@magnate.com.ar>',
              to: targetEmail,
              subject: emailSubject,
              html: emailHtml
            })
          });

          if (resendResponse.ok) {
            console.log('✅ Email enviado');
            results.sent_email++;
          } else {
            const errorText = await resendResponse.text();
            console.error('❌ Resend error:', errorText);
            results.errors.push(`Resend error: ${errorText}`);
          }
        }

        await supabase.rpc('delete_queue_message', { p_queue_name: QUEUE_NAME, p_msg_id: queueMsg.msg_id });
        results.processed++;

      } catch (error: any) {
        console.error(`❌ Error en msg ${queueMsg.msg_id}:`, error.message);
        results.failed++;
        results.errors.push(error.message);
      }
    }

    return new Response(JSON.stringify(results), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error: any) {
    console.error('❌ Error crítico:', error);
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
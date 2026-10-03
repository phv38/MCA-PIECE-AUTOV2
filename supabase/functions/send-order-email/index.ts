// @ts-nocheck
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};

function jsonResponse(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json'
    }
  });
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: 'EUR'
  }).format(Number(value || 0));
}

function getOrderReference(order: { id: string | number; created_at: string }) {
  const year = new Date(order.created_at || Date.now()).getFullYear();
  const digits = String(order.id ?? '').replace(/\D/g, '');
  const numericPart = digits ? digits.slice(-8).padStart(8, '0') : '00000000';
  return `CMD-${year}-${numericPart}`;
}

function getInvoiceNumber(order: { id: string | number; created_at: string }) {
  const year = new Date(order.created_at || Date.now()).getFullYear();
  const digits = String(order.id ?? '').replace(/\D/g, '');
  const numericPart = digits ? digits.slice(-8).padStart(8, '0') : '00000000';
  return `FAC-${year}-${numericPart}`;
}

function sanitizeFileSegment(value: string, fallback = 'document') {
  return String(value || fallback)
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || fallback;
}

function getInvoiceStoragePath(order: { id: string | number; user_id: string; created_at: string }) {
  const userSegment = sanitizeFileSegment(order.user_id || 'client');
  const orderSegment = sanitizeFileSegment(String(order.id || 'commande'));
  return `${userSegment}/${getInvoiceNumber(order)}-${orderSegment}.pdf`;
}

async function sendResendEmail({ apiKey, from, to, subject, html, text }: {
  apiKey: string;
  from: string;
  to: string | string[];
  subject: string;
  html: string;
  text: string;
}) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ from, to, subject, html, text })
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    console.error('[send-order-email] Resend API error', payload);
    throw new Error(payload?.message || 'Échec de l’envoi de l’email Resend.');
  }

  return payload;
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
    const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
    const resendApiKey = Deno.env.get('RESEND_API_KEY') || '';
    const resendFromEmail = Deno.env.get('RESEND_FROM_EMAIL') || 'MCA Pièces Autos <onboarding@resend.dev>';

    if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
      console.error('[send-order-email] Missing Supabase env vars');
      return jsonResponse(500, { error: 'Configuration Supabase incomplète.' });
    }

    if (!resendApiKey) {
      console.error('[send-order-email] Missing RESEND_API_KEY');
      return jsonResponse(500, { error: 'RESEND_API_KEY manquante.' });
    }

    const authHeader = request.headers.get('Authorization') || '';
    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        headers: { Authorization: authHeader }
      }
    });

    const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    });

    const { data: authData, error: authError } = await userClient.auth.getUser();
    if (authError || !authData?.user) {
      console.error('[send-order-email] Unauthorized user', authError);
      return jsonResponse(401, { error: 'Utilisateur non authentifié.' });
    }

    const body = await request.json().catch(() => ({}));
    const orderId = body?.orderId;
    if (!orderId) {
      console.error('[send-order-email] Missing orderId in payload');
      return jsonResponse(400, { error: 'orderId manquant.' });
    }

    const { data: order, error: orderError } = await adminClient
      .from('commandes')
      .select('*')
      .eq('id', orderId)
      .eq('user_id', authData.user.id)
      .maybeSingle();

    if (orderError) {
      console.error('[send-order-email] Order lookup failed', orderError);
      return jsonResponse(500, { error: orderError.message });
    }

    if (!order) {
      console.error('[send-order-email] Order not found or inaccessible', { orderId, userId: authData.user.id });
      return jsonResponse(404, { error: 'Commande introuvable.' });
    }

    const { data: details, error: detailsError } = await adminClient
      .from('commande_details')
      .select('produit_id, quantite, prix')
      .eq('commande_id', order.id);

    if (detailsError) {
      console.error('[send-order-email] Order details lookup failed', detailsError);
      return jsonResponse(500, { error: detailsError.message });
    }

    const productIds = [...new Set((details || []).map((detail) => detail.produit_id).filter(Boolean))];
    const { data: products, error: productsError } = await adminClient
      .from('produits')
      .select('id, nom, reference')
      .in('id', productIds);

    if (productsError) {
      console.error('[send-order-email] Products lookup failed', productsError);
      return jsonResponse(500, { error: productsError.message });
    }

    const { data: authUserResult, error: authUserError } = await adminClient.auth.admin.getUserById(authData.user.id);
    if (authUserError || !authUserResult?.user?.email) {
      console.error('[send-order-email] Customer email lookup failed', authUserError);
      return jsonResponse(500, { error: 'Impossible de récupérer l’email du client.' });
    }

    const invoicePath = getInvoiceStoragePath(order);
    const { data: signedUrlData, error: signedUrlError } = await adminClient.storage
      .from('factures')
      .createSignedUrl(invoicePath, 60 * 60 * 24);

    if (signedUrlError || !signedUrlData?.signedUrl) {
      console.error('[send-order-email] Invoice signed URL failed', { signedUrlError, invoicePath });
      return jsonResponse(500, { error: 'Impossible de générer le lien de téléchargement de la facture.' });
    }

    const productsMap = Object.fromEntries((products || []).map((product) => [String(product.id), product]));
    const items = (details || []).map((detail) => {
      const product = productsMap[String(detail.produit_id)] || {};
      return {
        nom: product.nom || 'Produit inconnu',
        quantite: Number(detail.quantite || 0),
        prix: Number(detail.prix || 0)
      };
    });

    const orderReference = getOrderReference(order);
    const invoiceLink = signedUrlData.signedUrl;
    const totalFormatted = formatCurrency(Number(order.total || 0));

    const itemsHtml = items.map((item) => `
      <li style="margin-bottom:8px;">
        <strong>${item.nom}</strong> — Quantité : ${item.quantite} — Prix : ${formatCurrency(item.prix)}
      </li>
    `).join('');

    const html = `
      <div style="font-family:Inter,Segoe UI,sans-serif;max-width:680px;margin:0 auto;background:#ffffff;color:#0f172a;">
        <div style="padding:24px 28px;background:linear-gradient(135deg,#111827,#1f2937);color:#ffffff;">
          <div style="font-size:14px;letter-spacing:.08em;text-transform:uppercase;opacity:.8;">MCA Pièces Autos 38</div>
          <h1 style="margin:8px 0 0;font-size:28px;">Confirmation de commande</h1>
        </div>
        <div style="padding:28px;">
          <p>Merci pour votre commande.</p>
          <p><strong>Numéro de commande :</strong> ${orderReference}</p>
          <p><strong>Total :</strong> ${totalFormatted}</p>
          <p><strong>Date :</strong> ${new Date(order.created_at).toLocaleString('fr-FR')}</p>
          <h2 style="font-size:18px;margin-top:24px;">Produits</h2>
          <ul style="padding-left:18px;">${itemsHtml}</ul>
          <p style="margin-top:24px;">
            <a href="${invoiceLink}" style="display:inline-block;background:#d20d1b;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:999px;font-weight:700;">Télécharger la facture PDF</a>
          </p>
        </div>
      </div>
    `;

    const text = [
      'Confirmation de commande MCA Pièces Autos 38',
      `Numéro de commande : ${orderReference}`,
      `Total : ${totalFormatted}`,
      `Date : ${new Date(order.created_at).toLocaleString('fr-FR')}`,
      '',
      'Produits :',
      ...items.map((item) => `- ${item.nom} | Quantité: ${item.quantite} | Prix: ${formatCurrency(item.prix)}`),
      '',
      `Télécharger la facture : ${invoiceLink}`
    ].join('\n');

    const resendResult = await sendResendEmail({
      apiKey: resendApiKey,
      from: resendFromEmail,
      to: authUserResult.user.email,
      subject: `Confirmation de votre commande ${orderReference}`,
      html,
      text
    });

    return jsonResponse(200, {
      success: true,
      emailId: resendResult?.id || null,
      orderReference,
      invoiceLink
    });
  } catch (error) {
    console.error('[send-order-email] unexpected error', error);
    return jsonResponse(500, {
      error: error instanceof Error ? error.message : 'Erreur inconnue lors de l’envoi de l’email.'
    });
  }
});

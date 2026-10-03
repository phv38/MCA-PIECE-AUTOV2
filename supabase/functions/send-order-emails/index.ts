// @ts-nocheck
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};

type OrderRow = {
  id: string | number;
  user_id: string;
  total: number;
  statut: string | null;
  created_at: string;
};

type ProfileRow = {
  id: string;
  nom: string | null;
  prenom: string | null;
  telephone: string | null;
  role: string | null;
};

type DetailRow = {
  produit_id: string | number;
  quantite: number;
  prix: number;
};

type ProductRow = {
  id: string | number;
  nom: string | null;
  reference: string | null;
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

function formatDate(value: string) {
  return new Intl.DateTimeFormat('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
}

function getOrderReference(order: OrderRow) {
  const year = new Date(order.created_at || Date.now()).getFullYear();
  const digits = String(order.id ?? '').replace(/\D/g, '');
  const numericPart = digits ? digits.slice(-8).padStart(8, '0') : '00000000';
  return `CMD-${year}-${numericPart}`;
}

function escapeHtml(value: string) {
  return String(value || '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char] as string));
}

async function sendResendEmail({
  apiKey,
  from,
  to,
  subject,
  html,
  text
}: {
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
    throw new Error(payload?.message || 'Échec de l’envoi Resend.');
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
    const resendAdminEmail = Deno.env.get('RESEND_ADMIN_EMAIL') || 'contact@mcapiecesautos38.fr';

    if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
      return jsonResponse(500, { error: 'Configuration Supabase incomplète pour la fonction email.' });
    }

    if (!resendApiKey) {
      return jsonResponse(500, { error: 'RESEND_API_KEY manquante dans les secrets de la fonction.' });
    }

    const authHeader = request.headers.get('Authorization') || '';
    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        headers: {
          Authorization: authHeader
        }
      }
    });

    const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });

    const { data: authData, error: authError } = await userClient.auth.getUser();
    if (authError || !authData?.user) {
      return jsonResponse(401, { error: 'Utilisateur non authentifié pour l’envoi des emails de commande.' });
    }

    const body = await request.json().catch(() => ({}));
    const orderId = body?.orderId;
    if (!orderId) {
      return jsonResponse(400, { error: 'orderId manquant.' });
    }

    const { data: viewerProfile } = await adminClient
      .from('profils')
      .select('id, role')
      .eq('id', authData.user.id)
      .maybeSingle();

    const isAdmin = String(viewerProfile?.role || '').trim().toLowerCase() === 'admin';

    const { data: order, error: orderError } = await adminClient
      .from('commandes')
      .select('*')
      .eq('id', orderId)
      .maybeSingle<OrderRow>();

    if (orderError) {
      return jsonResponse(500, { error: orderError.message });
    }

    if (!order) {
      return jsonResponse(404, { error: 'Commande introuvable.' });
    }

    if (!isAdmin && String(order.user_id) !== String(authData.user.id)) {
      return jsonResponse(403, { error: 'Commande inaccessible.' });
    }

    const { data: details, error: detailsError } = await adminClient
      .from('commande_details')
      .select('produit_id, quantite, prix')
      .eq('commande_id', order.id);

    if (detailsError) {
      return jsonResponse(500, { error: detailsError.message });
    }

    const productIds = [...new Set((details || []).map((detail: DetailRow) => detail.produit_id).filter(Boolean))];
    const { data: products, error: productsError } = await adminClient
      .from('produits')
      .select('id, nom, reference')
      .in('id', productIds);

    if (productsError) {
      return jsonResponse(500, { error: productsError.message });
    }

    const { data: customerProfile } = await adminClient
      .from('profils')
      .select('id, nom, prenom, telephone, role')
      .eq('id', order.user_id)
      .maybeSingle<ProfileRow>();

    const { data: customerAuthResult, error: customerAuthError } = await adminClient.auth.admin.getUserById(order.user_id);
    if (customerAuthError || !customerAuthResult?.user?.email) {
      return jsonResponse(500, { error: 'Impossible de récupérer l’email du client.' });
    }

    const customerEmail = customerAuthResult.user.email;
    const customerName = [customerProfile?.prenom, customerProfile?.nom].filter(Boolean).join(' ') || 'Client MCA';
    const customerPhone = customerProfile?.telephone || 'Non renseigné';
    const orderReference = getOrderReference(order);
    const orderDate = formatDate(order.created_at);

    const productsMap = Object.fromEntries((products || []).map((product: ProductRow) => [String(product.id), product]));
    const lineItems = (details || []).map((detail: DetailRow) => {
      const product = productsMap[String(detail.produit_id)] || {};
      const quantity = Number(detail.quantite || 0);
      const unitPrice = Number(detail.prix || 0);
      return {
        nom: product.nom || 'Produit inconnu',
        reference: product.reference || '-',
        quantite: quantity,
        prixUnitaire: unitPrice,
        totalLigne: quantity * unitPrice
      };
    });

    const rowsHtml = lineItems.map((item) => `
      <tr>
        <td style="padding:12px;border:1px solid #e2e8f0;">${escapeHtml(item.nom)}</td>
        <td style="padding:12px;border:1px solid #e2e8f0;">${escapeHtml(item.reference)}</td>
        <td style="padding:12px;border:1px solid #e2e8f0;text-align:center;">${item.quantite}</td>
        <td style="padding:12px;border:1px solid #e2e8f0;text-align:right;">${formatCurrency(item.prixUnitaire)}</td>
        <td style="padding:12px;border:1px solid #e2e8f0;text-align:right;">${formatCurrency(item.totalLigne)}</td>
      </tr>
    `).join('');

    const commonHtml = `
      <div style="font-family:Inter,Segoe UI,sans-serif;color:#0f172a;max-width:760px;margin:0 auto;background:#ffffff;">
        <div style="padding:24px 28px;background:linear-gradient(135deg,#111827,#1f2937);color:#ffffff;">
          <div style="font-size:14px;letter-spacing:.08em;text-transform:uppercase;opacity:.8;">MCA Pièces Autos 38</div>
          <h1 style="margin:8px 0 0;font-size:28px;">Confirmation de commande</h1>
        </div>
        <div style="padding:28px;">
          <div style="display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:24px;">
            <div>
              <div style="font-size:12px;text-transform:uppercase;color:#64748b;">Commande</div>
              <div style="font-size:20px;font-weight:700;">${escapeHtml(orderReference)}</div>
              <div style="margin-top:6px;color:#475569;">Date : ${escapeHtml(orderDate)}</div>
            </div>
            <div>
              <div style="font-size:12px;text-transform:uppercase;color:#64748b;">Client</div>
              <div style="font-size:16px;font-weight:700;">${escapeHtml(customerName)}</div>
              <div style="margin-top:6px;color:#475569;">${escapeHtml(customerEmail)}</div>
              <div style="color:#475569;">${escapeHtml(customerPhone)}</div>
            </div>
          </div>
          <table style="width:100%;border-collapse:collapse;margin:20px 0;">
            <thead>
              <tr style="background:#d20d1b;color:#ffffff;">
                <th style="padding:12px;border:1px solid #d20d1b;text-align:left;">Produit</th>
                <th style="padding:12px;border:1px solid #d20d1b;text-align:left;">Référence</th>
                <th style="padding:12px;border:1px solid #d20d1b;text-align:center;">Qté</th>
                <th style="padding:12px;border:1px solid #d20d1b;text-align:right;">Prix unitaire</th>
                <th style="padding:12px;border:1px solid #d20d1b;text-align:right;">Total</th>
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>
          <div style="display:flex;justify-content:flex-end;margin-top:24px;">
            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:14px;padding:16px 20px;min-width:220px;">
              <div style="font-size:12px;text-transform:uppercase;color:#64748b;">Montant total</div>
              <div style="font-size:24px;font-weight:800;color:#111827;margin-top:6px;">${formatCurrency(Number(order.total || 0))}</div>
            </div>
          </div>
        </div>
      </div>
    `;

    const commonText = [
      `Commande ${orderReference}`,
      `Date : ${orderDate}`,
      `Client : ${customerName}`,
      `Email : ${customerEmail}`,
      `Téléphone : ${customerPhone}`,
      '',
      ...lineItems.map((item) => `${item.nom} | Réf: ${item.reference} | Qté: ${item.quantite} | PU: ${formatCurrency(item.prixUnitaire)} | Total: ${formatCurrency(item.totalLigne)}`),
      '',
      `Montant total : ${formatCurrency(Number(order.total || 0))}`
    ].join('\n');

    const customerEmailResult = await sendResendEmail({
      apiKey: resendApiKey,
      from: resendFromEmail,
      to: customerEmail,
      subject: `Confirmation de votre commande ${orderReference}`,
      html: commonHtml,
      text: commonText
    });

    const adminEmailResult = await sendResendEmail({
      apiKey: resendApiKey,
      from: resendFromEmail,
      to: resendAdminEmail,
      subject: `Nouvelle commande ${orderReference}`,
      html: commonHtml,
      text: commonText
    });

    return jsonResponse(200, {
      success: true,
      customerEmailId: customerEmailResult?.id || null,
      adminEmailId: adminEmailResult?.id || null,
      orderReference
    });
  } catch (error) {
    console.error('[send-order-emails] unexpected error', error);
    return jsonResponse(500, {
      error: error instanceof Error ? error.message : 'Erreur inconnue lors de l’envoi des emails de commande.'
    });
  }
});

(function () {
  const INVOICE_BUCKET = 'factures';

  function formatCurrency(value) {
    return new Intl.NumberFormat('fr-FR', {
      style: 'currency',
      currency: 'EUR'
    }).format(Number(value || 0));
  }

  function formatDate(value) {
    return new Date(value || Date.now()).toLocaleDateString('fr-FR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    });
  }

  function sanitizeFileSegment(value, fallback = 'document') {
    return String(value || fallback)
      .trim()
      .replace(/[^a-zA-Z0-9_-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || fallback;
  }

  function getInvoiceNumber(order = {}) {
    const year = new Date(order.created_at || Date.now()).getFullYear();
    const rawId = String(order.id ?? '').replace(/\D/g, '');
    const numericPart = rawId ? rawId.slice(-8).padStart(8, '0') : '00000000';
    return `FAC-${year}-${numericPart}`;
  }

  function getInvoiceFileName(order = {}) {
    return `${getInvoiceNumber(order)}.pdf`;
  }

  function getInvoiceStoragePath(order = {}) {
    const userSegment = sanitizeFileSegment(order.user_id || 'client');
    const orderSegment = sanitizeFileSegment(order.id || 'commande');
    return `${userSegment}/${getInvoiceNumber(order)}-${orderSegment}.pdf`;
  }

  function getJsPdf() {
    return window.jspdf?.jsPDF || null;
  }

  async function getCurrentUser() {
    if (!window.mcaAuth?.getUser) {
      throw new Error('Authentification Supabase indisponible.');
    }

    const { data, error } = await window.mcaAuth.getUser();
    if (error) throw error;
    if (!data?.user) throw new Error('Vous devez être connecté pour accéder aux factures.');
    return data.user;
  }

  async function fetchProfile(userId) {
    if (!userId) return null;

    const { data, error } = await window.supabaseClient
      .from('profils')
      .select('id, nom, prenom, telephone, role')
      .eq('id', userId)
      .maybeSingle();

    if (error) {
      console.error('[invoice] profile lookup failed', error);
      return null;
    }

    return data || null;
  }

  function isAdminProfile(profile) {
    return String(profile?.role || '').trim().toLowerCase() === 'admin';
  }

  async function enrichOrderDetails(details = []) {
    const safeDetails = Array.isArray(details) ? details : [];
    const productIds = [...new Set(safeDetails.map((detail) => Number(detail.produit_id)).filter(Boolean))];

    let productsMap = {};
    if (productIds.length) {
      const { data: products, error } = await window.supabaseClient
        .from('produits')
        .select('id, nom, reference, prix')
        .in('id', productIds);

      if (error) {
        console.error('[invoice] products lookup failed', error);
      } else {
        productsMap = Object.fromEntries((products || []).map((product) => [String(product.id), product]));
      }
    }

    return safeDetails.map((detail) => {
      const product = productsMap[String(detail.produit_id)] || {};
      const quantity = Number(detail.quantite || 0);
      const unitPrice = Number(product.prix ?? detail.prix ?? 0);
      return {
        ...detail,
        productName: product.nom || detail.productName || 'Produit inconnu',
        productReference: product.reference || detail.productReference || '',
        productPrice: unitPrice,
        quantity,
        subtotal: unitPrice * quantity
      };
    });
  }

  async function fetchOrderBundle(orderId, { allowAdmin = false } = {}) {
    if (!orderId) throw new Error('Commande introuvable pour la facture.');

    const currentUser = await getCurrentUser();
    const viewerProfile = await fetchProfile(currentUser.id);
    const canAccessAllOrders = allowAdmin || isAdminProfile(viewerProfile);

    let orderQuery = window.supabaseClient
      .from('commandes')
      .select('*')
      .eq('id', orderId);

    if (!canAccessAllOrders) {
      orderQuery = orderQuery.eq('user_id', currentUser.id);
    }

    const { data: order, error: orderError } = await orderQuery.maybeSingle();
    if (orderError) throw orderError;
    if (!order) throw new Error('Commande introuvable ou inaccessible pour la facture.');

    const { data: rawDetails, error: detailsError } = await window.supabaseClient
      .from('commande_details')
      .select('*')
      .eq('commande_id', order.id);

    if (detailsError) throw detailsError;

    const details = await enrichOrderDetails(rawDetails || []);
    const customerProfile = await fetchProfile(order.user_id);

    return {
      order,
      details,
      currentUser,
      viewerProfile,
      customerProfile
    };
  }

  function buildCustomerData(context) {
    const { order, currentUser, customerProfile } = context;
    const isOwnOrder = String(order.user_id) === String(currentUser?.id || '');
    const prenom = String(customerProfile?.prenom || '').trim();
    const nom = String(customerProfile?.nom || '').trim();
    const fullName = [prenom, nom].filter(Boolean).join(' ') || currentUser?.user_metadata?.full_name || 'Client MCA';
    const phone = customerProfile?.telephone || currentUser?.user_metadata?.phone || 'Non renseigné';
    const email = isOwnOrder ? (currentUser?.email || 'Non renseigné') : 'Non disponible';

    return { fullName, phone, email };
  }

  function createInvoicePdf(context) {
    const JsPdf = getJsPdf();
    if (!JsPdf) {
      throw new Error('Le moteur PDF n’est pas chargé.');
    }

    const doc = new JsPdf({ unit: 'pt', format: 'a4' });
    const invoiceNumber = getInvoiceNumber(context.order);
    const customer = buildCustomerData(context);
    const orderDate = formatDate(context.order.created_at);
    const generatedDate = formatDate(new Date().toISOString());
    const pageWidth = doc.internal.pageSize.getWidth();

    doc.setFillColor(210, 13, 27);
    doc.roundedRect(40, 36, 78, 38, 10, 10, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(18);
    doc.text('MCA', 56, 61);

    doc.setTextColor(17, 24, 39);
    doc.setFontSize(18);
    doc.text('MCA PIÈCES AUTOS 38', 132, 56);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(100, 116, 139);
    doc.text('372 Route du Barrage, 38121 Reventin-Vaugris', 132, 73);
    doc.text('04 51 26 35 55 • contact@mcapiecesautos38.fr', 132, 88);

    doc.setTextColor(17, 24, 39);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(22);
    doc.text('FACTURE', pageWidth - 40, 58, { align: 'right' });
    doc.setFontSize(11);
    doc.setFont('helvetica', 'normal');
    doc.text(`N° ${invoiceNumber}`, pageWidth - 40, 78, { align: 'right' });
    doc.text(`Date facture : ${generatedDate}`, pageWidth - 40, 94, { align: 'right' });
    doc.text(`Date commande : ${orderDate}`, pageWidth - 40, 110, { align: 'right' });

    doc.setDrawColor(226, 232, 240);
    doc.setFillColor(248, 250, 252);
    doc.roundedRect(40, 130, pageWidth - 80, 88, 12, 12, 'FD');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(210, 13, 27);
    doc.text('Coordonnées client', 56, 154);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(17, 24, 39);
    doc.text(`Nom : ${customer.fullName}`, 56, 176);
    doc.text(`Téléphone : ${customer.phone}`, 56, 194);
    doc.text(`Email : ${customer.email}`, 56, 212);

    const bodyRows = (context.details || []).map((item) => ([
      item.productName || 'Produit',
      item.productReference || '-',
      String(Number(item.quantity || 0)),
      formatCurrency(item.productPrice || 0),
      formatCurrency(item.subtotal || 0)
    ]));

    const totalAmount = Number(context.order.total || 0);

    doc.autoTable({
      startY: 240,
      head: [['Produit', 'Référence', 'Qté', 'Prix unitaire', 'Total ligne']],
      body: bodyRows,
      theme: 'grid',
      headStyles: {
        fillColor: [210, 13, 27],
        textColor: [255, 255, 255],
        fontStyle: 'bold'
      },
      bodyStyles: {
        textColor: [17, 24, 39],
        lineColor: [226, 232, 240]
      },
      alternateRowStyles: {
        fillColor: [248, 250, 252]
      },
      styles: {
        fontSize: 10,
        cellPadding: 8,
        overflow: 'linebreak'
      },
      columnStyles: {
        2: { halign: 'center', cellWidth: 45 },
        3: { halign: 'right', cellWidth: 90 },
        4: { halign: 'right', cellWidth: 90 }
      },
      margin: { left: 40, right: 40 }
    });

    const finalY = doc.lastAutoTable?.finalY || 470;
    doc.setFillColor(248, 250, 252);
    doc.roundedRect(pageWidth - 230, finalY + 22, 190, 60, 12, 12, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(71, 85, 105);
    doc.text('Total TTC', pageWidth - 214, finalY + 48);
    doc.setFontSize(18);
    doc.setTextColor(17, 24, 39);
    doc.text(formatCurrency(totalAmount), pageWidth - 56, finalY + 52, { align: 'right' });

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(100, 116, 139);
    doc.text('Merci pour votre confiance. Cette facture a été générée automatiquement par MCA Pièces Autos 38.', 40, finalY + 112);

    return { doc, invoiceNumber };
  }

  async function uploadInvoice(context) {
    const { doc, invoiceNumber } = createInvoicePdf(context);
    const pdfBlob = doc.output('blob');
    const storagePath = getInvoiceStoragePath(context.order);

    const { error } = await window.supabaseClient.storage
      .from(INVOICE_BUCKET)
      .upload(storagePath, pdfBlob, {
        contentType: 'application/pdf',
        upsert: true,
        cacheControl: '3600'
      });

    if (error) throw error;

    return {
      invoiceNumber,
      storagePath,
      fileName: getInvoiceFileName(context.order)
    };
  }

  async function getSignedInvoiceUrl(storagePath) {
    const { data, error } = await window.supabaseClient.storage
      .from(INVOICE_BUCKET)
      .createSignedUrl(storagePath, 3600);

    if (error) throw error;
    if (!data?.signedUrl) throw new Error('URL de facture introuvable.');
    return data.signedUrl;
  }

  function triggerDownload(url, fileName) {
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  async function ensureInvoiceForOrderId(orderId, options = {}) {
    const context = await fetchOrderBundle(orderId, options);
    return uploadInvoice(context);
  }

  async function downloadInvoiceForOrder(orderId, options = {}) {
    const context = await fetchOrderBundle(orderId, options);
    const uploadResult = await uploadInvoice(context);
    const signedUrl = await getSignedInvoiceUrl(uploadResult.storagePath);
    triggerDownload(signedUrl, uploadResult.fileName);
    return { ...uploadResult, signedUrl };
  }

  document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-download-invoice]');
    if (!button) return;

    event.preventDefault();
    const orderId = button.dataset.downloadInvoice;
    const allowAdmin = button.dataset.invoiceAdmin === '1';
    const initialLabel = button.dataset.initialLabel || button.textContent;
    button.dataset.initialLabel = initialLabel;
    button.disabled = true;
    button.textContent = 'Préparation...';

    try {
      await downloadInvoiceForOrder(orderId, { allowAdmin });
    } catch (error) {
      console.error('[invoice] download failed', error);
      window.alert(`Impossible de télécharger la facture : ${error.message || 'erreur inconnue'}`);
    } finally {
      button.disabled = false;
      button.textContent = initialLabel;
    }
  });

  window.mcaInvoices = {
    getInvoiceNumber,
    getInvoiceFileName,
    getInvoiceStoragePath,
    ensureInvoiceForOrderId,
    downloadInvoiceForOrder
  };
})();

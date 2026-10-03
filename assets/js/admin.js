const ADMIN_PRODUCTS_TABLE = 'produits';
const ADMIN_PROFILES_TABLE = 'profils';
const PRODUCT_IMAGES_BUCKET = 'produits';
const ADMIN_ORDER_STATUSES = ['En attente', 'Préparation', 'Expédiée', 'Terminée', 'Annulée'];
let adminProducts = [];
let activeAdminUser = null;
let adminRealtimeChannel = null;
let adminOrderFilter = 'all';
let adminOrdersCache = [];
let adminProfilesCache = {};
let lastFiveOrders = [];
let topFiveProducts = [];

function buildProductImageStoragePath(file) {
  const originalName = String(file?.name || 'produit').trim() || 'produit';
  const safeName = originalName
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-');

  return `images/${Date.now()}-${crypto.randomUUID?.() || Math.random().toString(36).slice(2)}-${safeName}`;
}

async function uploadProductImage(file) {
  if (!file) return null;
  if (!file.type.startsWith('image/')) throw new Error('Choisissez un fichier image valide.');
  if (file.size > 5 * 1024 * 1024) throw new Error('L’image ne doit pas dépasser 5 Mo.');

  try {
    const storagePath = buildProductImageStoragePath(file);
    const { error: uploadError } = await window.supabaseClient.storage
      .from(PRODUCT_IMAGES_BUCKET)
      .upload(storagePath, file, {
        cacheControl: '3600',
        upsert: false,
        contentType: file.type
      });

    if (uploadError) {
      console.error('[admin] uploadProductImage failed', uploadError);
      throw new Error(`Erreur upload image : ${uploadError.message || 'impossible d’envoyer le fichier.'}`);
    }

    const { data: publicUrlData } = window.supabaseClient.storage
      .from(PRODUCT_IMAGES_BUCKET)
      .getPublicUrl(storagePath);

    if (!publicUrlData?.publicUrl) {
      throw new Error('L’URL publique de l’image est introuvable après l’upload.');
    }

    return publicUrlData.publicUrl;
  } catch (error) {
    console.error('[admin] uploadProductImage exception', error);
    throw error;
  }
}

function getNormalizedRole(value) {
  return String(value ?? '').trim().toLowerCase();
}

async function checkAdminAccess(user) {
  console.log('[admin] utilisateur connecté', user);
  console.log('[admin] id utilisateur', user?.id);

  if (!user?.id) {
    const blockingCondition = 'user.id absent';
    console.log('[admin] condition qui bloque l’accès', blockingCondition);
    return { allowed: false, profile: null, role: '', reason: 'missing_user_id', blockingCondition };
  }

  const { data: profile, error } = await window.supabaseClient
    .from('profils')
    .select('id, role')
    .eq('id', user.id)
    .maybeSingle();

  console.log('[admin] profil récupéré', profile);
  console.log('[admin] role récupéré', profile?.role ?? '');
  console.log('[admin] erreur lecture profil', error);

  const role = getNormalizedRole(profile?.role);
  const blockingCondition = !profile
    ? 'profil absent dans public.profils'
    : role !== 'admin'
      ? `role = "${profile?.role ?? 'inconnu'}" dans public.profils`
      : null;

  console.log('[admin] condition qui bloque l’accès', {
    userId: user.id,
    table: 'profils',
    profileExists: Boolean(profile),
    role,
    blockingCondition
  });

  if (error) {
    return { allowed: false, profile: null, role, reason: 'profile_query_error', blockingCondition: error.message };
  }

  if (!profile) {
    return { allowed: false, profile: null, role, reason: 'profile_missing', blockingCondition };
  }

  if (role !== 'admin') {
    return { allowed: false, profile, role, reason: 'role_not_admin', blockingCondition };
  }

  return { allowed: true, profile, role, reason: 'role_is_admin', blockingCondition: null };
}

function isAdmin(user, profile = null) {
  const roleSource = profile?.role ?? user?.role ?? user?.app_metadata?.role ?? '';
  return getNormalizedRole(roleSource) === 'admin';
}

function setAdminMessage(message, isError = false) {
  const node = document.getElementById('admin-auth-message');
  if (!node) return;
  node.textContent = message;
  node.classList.toggle('text-danger', isError);
  node.classList.toggle('text-muted', !isError);
}

function setDashboardValue(id, value) {
  const node = document.getElementById(id);
  if (!node) return;
  node.textContent = value;
}

function formatDashboardCurrency(value) {
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(Number(value || 0));
}

async function loadDashboardRecentOrders() {
  const { data, error } = await window.supabaseClient
    .from('commandes')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(5);

  console.log('[dashboard] 5 dernières commandes reçues', { table: 'commandes', data, error });

  if (error) {
    console.error('[dashboard] erreur chargement 5 dernières commandes', error);
    const container = document.getElementById('dashboard-last-orders');
    if (container) {
      container.innerHTML = '<div class="dashboard-empty">Impossible de charger les commandes.</div>';
    }
    return;
  }

  lastFiveOrders = data || [];
  renderDashboardRecentOrders();
}

function renderDashboardRecentOrders() {
  const container = document.getElementById('dashboard-last-orders');
  if (!container) return;

  if (!lastFiveOrders.length) {
    container.innerHTML = '<div class="dashboard-empty">Aucune commande enregistrée.</div>';
    return;
  }

  container.innerHTML = lastFiveOrders.map((order) => {
    const clientName = getClientDisplayName(order.user_id, adminProfilesCache);
    const date = new Date(order.created_at).toLocaleDateString('fr-FR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    });
    const total = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(Number(order.total || 0));

    return `
      <div class="dashboard-item">
        <div>
          <div class="dashboard-item__title">${escapeHtml(getOrderReference(order))}</div>
          <div class="dashboard-item__meta">${escapeHtml(clientName)} · ${date}</div>
        </div>
        <div class="dashboard-item__right">
          <div class="dashboard-item__amount">${total}</div>
          <span class="status-badge status-attente">${escapeHtml(order.statut || 'En attente')}</span>
        </div>
      </div>
    `;
  }).join('');
}

async function loadDashboardTopProducts() {
  const [detailsResult, productsResult] = await Promise.all([
    window.supabaseClient.from('commande_details').select('produit_id, quantite'),
    window.supabaseClient.from('produits').select('id, nom')
  ]);

  console.log('[dashboard] commande_details reçues', { table: 'commande_details', data: detailsResult.data, error: detailsResult.error });
  console.log('[dashboard] produits reçus pour le nom', { table: 'produits', data: productsResult.data, error: productsResult.error });

  if (detailsResult.error) {
    console.error('[dashboard] erreur chargement commande_details', detailsResult.error);
    const container = document.getElementById('dashboard-top-products');
    if (container) {
      container.innerHTML = '<div class="dashboard-empty">Impossible de charger les produits vendus.</div>';
    }
    return;
  }

  const productMap = Object.fromEntries((productsResult.data || []).map((product) => [String(product.id), product]));
  const soldByProduct = {};

  (detailsResult.data || []).forEach((detail) => {
    const productId = String(detail.produit_id);
    const quantity = Number(detail.quantite || 0);

    if (!productId || !productMap[productId]) return;
    soldByProduct[productId] = (soldByProduct[productId] || 0) + quantity;
  });

  topFiveProducts = Object.entries(soldByProduct)
    .map(([productId, totalQuantity]) => ({
      produit_id: Number(productId),
      nom: productMap[productId]?.nom || 'Produit inconnu',
      quantite: totalQuantity
    }))
    .sort((a, b) => b.quantite - a.quantite)
    .slice(0, 5);

  console.log('[dashboard] top 5 produits calculés à partir de commande_details', topFiveProducts);
  renderDashboardTopProducts();
}

function renderDashboardTopProducts() {
  const container = document.getElementById('dashboard-top-products');
  if (!container) return;

  if (!topFiveProducts.length) {
    container.innerHTML = '<div class="dashboard-empty">Aucun produit vendu pour le moment.</div>';
    return;
  }

  container.innerHTML = topFiveProducts.map((item, index) => `
    <div class="dashboard-item">
      <div>
        <div class="dashboard-item__title">${index + 1}. ${escapeHtml(item.nom || 'Produit inconnu')}</div>
        <div class="dashboard-item__meta">Quantité vendue : ${Number(item.quantite || 0)}</div>
      </div>
      <div class="dashboard-item__right">
        <div class="dashboard-item__amount">${Number(item.quantite || 0)} pcs</div>
      </div>
    </div>
  `).join('');
}

async function loadAdminDashboardMetrics() {
  console.log('[dashboard] Vérification des requêtes de métriques réelles…');

  const [productsResult, ordersResult, profilesResult, revenueResult] = await Promise.all([
    window.supabaseClient
      .from('produits')
      .select('id', { count: 'exact', head: true }),
    window.supabaseClient
      .from('commandes')
      .select('id', { count: 'exact', head: true }),
    window.supabaseClient
      .from('profils')
      .select('id', { count: 'exact', head: true }),
    window.supabaseClient
      .from('commandes')
      .select('total')
  ]);

  const productsCount = productsResult.count ?? 0;
  const ordersCount = ordersResult.count ?? 0;
  const profilesCount = profilesResult.count ?? 0;
  const totalRevenue = (revenueResult.data || []).reduce((sum, row) => sum + Number(row.total || 0), 0);

  const productsOut = (adminProducts || []).filter((product) => Number(product.stock || 0) === 0).length;
  const productsLow = (adminProducts || []).filter((product) => Number(product.stock || 0) > 0 && Number(product.stock || 0) <= Number(product.stock_min || 0)).length;

  const today = new Date();
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const ordersToday = (adminOrdersCache || []).filter((order) => new Date(order.created_at || Date.now()) >= todayStart).length;

  const monthRevenue = (adminOrdersCache || []).reduce((sum, order) => {
    const date = new Date(order.created_at || Date.now());
    if (date.getMonth() === today.getMonth() && date.getFullYear() === today.getFullYear()) {
      return sum + Number(order.total || 0);
    }
    return sum;
  }, 0);

  console.log('[dashboard] count produits', { table: 'produits', count: productsCount, result: productsResult });
  console.log('[dashboard] count commandes', { table: 'commandes', count: ordersCount, result: ordersResult });
  console.log('[dashboard] count profils', { table: 'profils', count: profilesCount, result: profilesResult });
  console.log('[dashboard] sum(commandes.total)', { table: 'commandes', total: totalRevenue, result: revenueResult });

  setDashboardValue('dashboard-total-products', productsCount);
  setDashboardValue('dashboard-total-orders', ordersCount);
  setDashboardValue('dashboard-total-clients', profilesCount);
  setDashboardValue('dashboard-orders-today', ordersToday);
  setDashboardValue('dashboard-revenue-total', formatDashboardCurrency(totalRevenue));
  setDashboardValue('dashboard-revenue-month', formatDashboardCurrency(monthRevenue));
  setDashboardValue('dashboard-products-out', productsOut);
  setDashboardValue('dashboard-products-low', productsLow);
}

async function openAdminDashboard(user, access = null) {
  const adminAccess = access || (await checkAdminAccess(user));
  console.log('[admin] vérification finale accès', adminAccess);

  if (!adminAccess.allowed) {
    activeAdminUser = null;
    showAdminLogin();
    setAdminMessage(`Accès refusé : ${adminAccess.blockingCondition || 'vous n’avez pas les autorisations'}.`, true);
    return;
  }

  activeAdminUser = { ...user, role: adminAccess.role };
  document.getElementById('admin-login-panel').hidden = true;
  document.getElementById('admin-content').hidden = false;
  document.getElementById('admin-user-label').textContent = `Connecté : ${user.email}`;
  setAdminMessage('Accès administrateur vérifié.');
  await loadAdminProducts();
  await loadAdminOrders();
  await loadAdminDashboardMetrics();
  await loadDashboardRecentOrders();
  await loadDashboardTopProducts();
}

function normalizeAdminProduct(row = {}) {
  const normalized = {
    id: row.id,
    nom: String(row.nom ?? row.name ?? '').trim(),
    reference: String(row.reference ?? '').trim(),
    description: String(row.description ?? '').trim(),
    prix: Number(row.prix ?? row.price ?? 0),
    stock: Number(row.stock ?? 0),
    stock_min: Number(row.stock_min ?? 5),
    categorie: String(row.categorie ?? row.category ?? '').trim(),
    image: row.image ?? row.image_url ?? ''
  };

  console.log('[admin] normalizeAdminProduct input', row);
  console.log('[admin] normalizeAdminProduct output', normalized);
  return normalized;
}

function updateAdminStats() {
  const stockCount = adminProducts.reduce((sum, product) => sum + Number(product.stock || 0), 0);
  const lowStockCount = adminProducts.filter((product) => Number(product.stock || 0) <= 5).length;
  document.getElementById('admin-product-count').textContent = String(adminProducts.length);
  document.getElementById('admin-stock-count').textContent = String(stockCount);
  document.getElementById('admin-low-stock-count').textContent = String(lowStockCount);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

function renderAdminProducts(products = adminProducts) {
  const table = document.getElementById('admin-products-table');
  const search = (document.getElementById('admin-product-search')?.value || '').trim().toLowerCase();
  const rows = products.filter((product) => `${product.nom || ''} ${product.reference || ''} ${product.categorie || ''}`.toLowerCase().includes(search));

  if (!rows.length) {
    table.innerHTML = `<tr><td colspan="5" class="text-muted">${products.length ? 'Aucun résultat.' : 'Aucun produit enregistré.'}</td></tr>`;
    return;
  }

  table.innerHTML = rows.map((product) => `
    <tr>
      <td>
        <div class="d-flex align-items-center gap-3">
          ${product.image ? `<img src="${escapeHtml(product.image)}" alt="${escapeHtml(product.nom || 'Produit')}" width="48" height="48" class="rounded object-fit-cover" />` : '<div class="rounded bg-light d-flex align-items-center justify-content-center" style="width:48px;height:48px;"><i class="fa-solid fa-image text-muted"></i></div>'}
          <div>
            <div class="fw-semibold">${escapeHtml(product.nom || 'Produit sans nom')}</div>
            <div class="small text-muted">${escapeHtml(product.reference || '-')}</div>
          </div>
        </div>
      </td>
      <td>${escapeHtml(product.categorie || '-')}</td>
      <td>${new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(Number(product.prix || 0))}</td>
      <td>
        <div class="d-flex align-items-center gap-2">
          <input type="number" min="0" step="1" value="${Number(product.stock || 0)}" class="form-control form-control-sm" style="width:80px;" data-stock-input="${product.id}" />
          <button class="btn btn-sm btn-outline-primary" type="button" data-stock-update="${product.id}">Maj</button>
        </div>
      </td>
      <td class="text-nowrap">
        <button class="btn btn-sm btn-outline-primary me-2" type="button" data-edit-product="${product.id}"><i class="fa-solid fa-pen"></i></button>
        <button class="btn btn-sm btn-outline-danger" type="button" data-delete-product="${product.id}"><i class="fa-solid fa-trash"></i></button>
      </td>
    </tr>
  `).join('');

  table.querySelectorAll('[data-edit-product]').forEach((button) => {
    button.addEventListener('click', () => editAdminProduct(button.dataset.editProduct));
  });

  table.querySelectorAll('[data-delete-product]').forEach((button) => {
    button.addEventListener('click', () => deleteAdminProduct(button.dataset.deleteProduct));
  });

  table.querySelectorAll('[data-stock-update]').forEach((button) => {
    button.addEventListener('click', () => {
      const productId = button.dataset.stockUpdate;
      const input = table.querySelector(`[data-stock-input="${productId}"]`);
      if (!input) return;
      updateAdminProductStock(productId, Number(input.value));
    });
  });
}

async function loadAdminProducts() {
  setAdminMessage('Chargement des produits…');
  console.log('[admin] loadAdminProducts start', { table: ADMIN_PRODUCTS_TABLE });

  const { data, error } = await window.supabaseClient
    .from(ADMIN_PRODUCTS_TABLE)
    .select('*')
    .order('id', { ascending: true });

  console.log('[admin] loadAdminProducts raw data', data);
  console.log('[admin] loadAdminProducts error', error);

  if (error) {
    console.error('[admin] loadAdminProducts failed', error);
    setAdminMessage(`Lecture impossible : ${error.message}. Vérifiez la table ${ADMIN_PRODUCTS_TABLE} et les règles RLS.`, true);
    return;
  }

  adminProducts = (data || []).map(normalizeAdminProduct);
  console.log('[admin] loadAdminProducts normalized', adminProducts);

  updateAdminStats();
  renderAdminProducts();
  setAdminMessage(`${adminProducts.length} produit${adminProducts.length > 1 ? 's' : ''} chargé${adminProducts.length > 1 ? 's' : ''}.`);
}

async function loadProducts() {
  return loadAdminProducts();
}

function resetProductForm() {
  const form = document.getElementById('product-form');
  if (!form) return;
  form.reset();
  form.elements.id.value = '';
  form.elements.image.value = '';
  form.elements.stock_min.value = '5';
  document.getElementById('product-form-title').textContent = 'Ajouter un produit';
  document.getElementById('save-product-button').textContent = 'Enregistrer le produit';
  document.getElementById('cancel-product-edit').hidden = true;
  const preview = document.getElementById('product-image-preview');
  if (preview) {
    preview.removeAttribute('src');
    preview.hidden = true;
  }
}

function populateEditForm(id) {
  const product = adminProducts.find((entry) => String(entry.id) === String(id));
  if (!product) return;

  const form = document.getElementById('product-form');
  if (!form) return;

  form.elements.id.value = product.id;
  form.elements.nom.value = product.nom || '';
  form.elements.reference.value = product.reference || '';
  form.elements.description.value = product.description || '';
  form.elements.prix.value = product.prix ?? 0;
  form.elements.stock.value = product.stock ?? 0;
  form.elements.stock_min.value = product.stock_min ?? 5;
  form.elements.categorie.value = product.categorie || '';
  form.elements.image.value = product.image || '';
  form.elements.image_file.value = '';

  document.getElementById('product-form-title').textContent = `Modifier : ${product.nom || 'Produit'}`;
  document.getElementById('save-product-button').textContent = 'Enregistrer les modifications';
  document.getElementById('cancel-product-edit').hidden = false;

  const preview = document.getElementById('product-image-preview');
  if (product.image) {
    preview.src = product.image;
    preview.hidden = false;
  } else {
    preview.removeAttribute('src');
    preview.hidden = true;
  }
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function editAdminProduct(id) {
  populateEditForm(id);
}

async function createProduct(payload) {
  console.log('[admin] createProduct payload', payload);
  const { data, error } = await window.supabaseClient
    .from(ADMIN_PRODUCTS_TABLE)
    .insert([payload])
    .select();

  console.log('[admin] createProduct response', { data, error });
  return { data, error };
}

async function updateProduct(id, payload) {
  console.log('[admin] updateProduct payload', { id, payload });
  const { data, error } = await window.supabaseClient
    .from(ADMIN_PRODUCTS_TABLE)
    .update(payload)
    .eq('id', id)
    .select();

  console.log('[admin] updateProduct response', { data, error });
  return { data, error };
}

async function saveProduct(event) {
  event.preventDefault();
  if (!isAdmin(activeAdminUser)) return;

  const form = event.currentTarget;
  const id = form.elements.id.value;
  const submitButton = document.getElementById('save-product-button');
  submitButton.disabled = true;

  try {
    setAdminMessage(id ? 'Mise à jour du produit…' : 'Ajout du produit…');

    let imageUrl = form.elements.image.value || null;
    const file = form.elements.image_file.files[0];
    if (file) imageUrl = await uploadProductImage(file);

    const payload = {
      nom: String(form.elements.nom.value || '').trim(),
      reference: String(form.elements.reference.value || '').trim(),
      description: String(form.elements.description.value || '').trim() || null,
      prix: Number(form.elements.prix.value),
      stock: Number(form.elements.stock.value),
      stock_min: Number(form.elements.stock_min.value || 5),
      categorie: String(form.elements.categorie.value || '').trim(),
      image: imageUrl || null
    };

    console.log('[admin] saveProduct payload built', payload);

    if (!payload.nom || !payload.reference || !payload.categorie || Number.isNaN(payload.prix) || Number.isNaN(payload.stock)) {
      throw new Error('Tous les champs requis doivent être renseignés.');
    }

    const result = id
      ? await updateProduct(id, payload)
      : await createProduct(payload);

    console.log('[admin] saveProduct final result', result);

    if (result.error) throw result.error;

    resetProductForm();
    await loadAdminProducts();
  } catch (error) {
    console.error('[admin] saveProduct failed', error);
    setAdminMessage(`Enregistrement impossible : ${error.message}`, true);
  } finally {
    submitButton.disabled = false;
  }
}

async function saveAdminProduct(event) {
  return saveProduct(event);
}

async function updateAdminProductStock(productId, nextStock) {
  if (!isAdmin(activeAdminUser)) return;

  const normalized = Number(nextStock);
  if (Number.isNaN(normalized) || normalized < 0) {
    setAdminMessage('Le stock doit être un nombre positif.', true);
    return;
  }

  const payload = { stock: normalized };
  console.log('[admin] updateAdminProductStock payload', { productId, payload });

  setAdminMessage('Mise à jour du stock…');
  const { data, error } = await window.supabaseClient
    .from(ADMIN_PRODUCTS_TABLE)
    .update(payload)
    .eq('id', productId)
    .select();

  console.log('[admin] updateAdminProductStock response', { data, error });

  if (error) {
    console.error('[admin] updateAdminProductStock failed', error);
    setAdminMessage(`Mise à jour impossible : ${error.message}`, true);
    return;
  }

  await loadAdminProducts();
}

async function deleteAdminProduct(id) {
  if (!isAdmin(activeAdminUser)) return;
  const product = adminProducts.find((entry) => String(entry.id) === String(id));
  if (!product || !window.confirm(`Supprimer « ${product.nom || 'ce produit'} » ? Cette action est définitive.`)) return;

  setAdminMessage('Suppression du produit…');
  const { data, error } = await window.supabaseClient
    .from(ADMIN_PRODUCTS_TABLE)
    .delete()
    .eq('id', id)
    .select();

  console.log('[admin] deleteAdminProduct response', { data, error });

  if (error) {
    console.error('[admin] deleteAdminProduct failed', error);
    setAdminMessage(`Suppression impossible : ${error.message}`, true);
    return;
  }

  await loadAdminProducts();
}

async function handleAdminLogin(event) {
  event.preventDefault();
  const form = event.currentTarget;
  setAdminMessage('Connexion en cours…');

  const { data, error } = await window.mcaAuth.signInWithPassword({
    email: form.elements.email.value.trim(),
    password: form.elements.password.value
  });

  if (error) {
    setAdminMessage(error.message, true);
    return;
  }

  if (!data?.user) {
    setAdminMessage('Impossible de récupérer l’utilisateur administrateur.', true);
    return;
  }

  await openAdminDashboard(data.user);
}

async function handleAdminLogout() {
  const { error } = await window.mcaAuth.signOut();
  if (error) {
    setAdminMessage(error.message, true);
    return;
  }

  activeAdminUser = null;
  document.getElementById('admin-content').hidden = true;
  showAdminLogin();
  setAdminMessage('Vous êtes déconnecté.');
}

function subscribeToProductsRealtime() {
  if (!window.supabaseClient) return;

  if (adminRealtimeChannel) {
    window.supabaseClient.removeChannel(adminRealtimeChannel);
    adminRealtimeChannel = null;
  }

  adminRealtimeChannel = window.supabaseClient.channel('admin-products-realtime');
  adminRealtimeChannel
    .on('postgres_changes', { event: '*', schema: 'public', table: ADMIN_PRODUCTS_TABLE }, () => {
      console.log('[admin] products realtime change detected');
      loadAdminProducts();
    })
    .subscribe((status) => {
      console.log('[admin] realtime status', status);
    });
}

function getOrderReference(order) {
  const year = new Date(order?.created_at || Date.now()).getFullYear() || new Date().getFullYear();
  const orderId = Number(order?.id ?? 0);
  const numericId = Number.isFinite(orderId) && orderId > 0 ? orderId : 0;
  return `CMD-${year}-${String(numericId).padStart(4, '0')}`;
}

function getClientDisplayName(userId, profilesMap = adminProfilesCache) {
  const profile = profilesMap?.[userId];
  if (!profile) return 'Client inconnu';

  const prenom = String(profile.prenom ?? '').trim();
  const nom = String(profile.nom ?? '').trim();

  if (prenom && nom) return `${prenom} ${nom}`;
  if (prenom) return prenom;
  if (nom) return nom;
  return 'Client inconnu';
}

function renderAdminOrdersList(orders = adminOrdersCache) {
  const table = document.getElementById('admin-orders-table');
  if (!table) return;

  const filteredOrders = adminOrderFilter === 'all'
    ? orders
    : orders.filter((order) => (order.statut || 'En attente') === adminOrderFilter);

  if (!filteredOrders.length) {
    table.innerHTML = '<tr><td colspan="5" class="text-muted">Aucune commande pour ce filtre.</td></tr>';
    return;
  }

  table.innerHTML = filteredOrders.map((order) => {
    const reference = getOrderReference(order);
    const clientName = getClientDisplayName(order.user_id, adminProfilesCache);
    const status = order.statut || 'En attente';
    const date = new Date(order.created_at).toLocaleDateString('fr-FR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    });
    const total = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(Number(order.total || 0));

    return `
      <tr>
        <td class="fw-semibold">${escapeHtml(reference)}</td>
        <td>${escapeHtml(clientName)}</td>
        <td>${date}</td>
        <td>${total}</td>
        <td>
          <select class="form-select form-select-sm" data-order-status-select="${order.id}" aria-label="Changer le statut de la commande">
            ${ADMIN_ORDER_STATUSES.map((value) => `
              <option value="${value}" ${value === status ? 'selected' : ''}>${value}</option>
            `).join('')}
          </select>
        </td>
      </tr>
    `;
  }).join('');

  table.querySelectorAll('[data-order-status-select]').forEach((select) => {
    select.addEventListener('change', async (event) => {
      const orderId = event.target.dataset.orderStatusSelect;
      const nextStatus = event.target.value;
      await updateOrderStatus(orderId, nextStatus);
    });
  });
}

async function updateOrderStatus(orderId, nextStatus) {
  if (!orderId || !nextStatus) return;

  const payload = { statut: nextStatus };
  console.log('[admin] updateOrderStatus payload', { orderId, payload });

  const { data, error } = await window.supabaseClient
    .from('commandes')
    .update(payload)
    .eq('id', orderId)
    .select();

  console.log('[admin] updateOrderStatus response', { data, error });

  if (error) {
    console.error('[admin] updateOrderStatus failed', error);
    setAdminMessage(`Mise à jour du statut impossible : ${error.message}`, true);
    await loadAdminOrders();
    return;
  }

  setAdminMessage(`Statut de la commande mis à jour : ${nextStatus}`);
  await loadAdminOrders();
}

async function loadAdminOrders() {
  const table = document.getElementById('admin-orders-table');
  if (!table) return;

  try {
    const [ordersResult, profilesResult] = await Promise.all([
      window.supabaseClient
        .from('commandes')
        .select('*')
        .order('created_at', { ascending: false }),
      window.supabaseClient
        .from('profils')
        .select('id, nom, prenom')
    ]);

    const { data: ordersData, error: ordersError } = ordersResult;
    const { data: profilesData, error: profilesError } = profilesResult;

    if (ordersError) {
      console.error('[orders] admin load failed', ordersError);
      table.innerHTML = `<tr><td colspan="5" class="text-danger">Erreur : ${ordersError.message}</td></tr>`;
      return;
    }

    if (profilesError) {
      console.error('[orders] profiles load failed', profilesError);
    }

    adminOrdersCache = ordersData || [];
    adminProfilesCache = {};
    (profilesData || []).forEach((profile) => {
      adminProfilesCache[profile.id] = profile;
    });

    if (!adminOrdersCache.length) {
      table.innerHTML = '<tr><td colspan="5" class="text-muted">Aucune commande enregistrée.</td></tr>';
      return;
    }

    renderAdminOrdersList(adminOrdersCache);
  } catch (error) {
    console.error('[orders] admin render failed', error);
    table.innerHTML = '<tr><td colspan="5" class="text-danger">Impossible de charger les commandes.</td></tr>';
  }

  // Chargement des 5 dernières commandes
  try {
    const { data: lastOrdersData, error: lastOrdersError } = await window.supabaseClient
      .from('commandes')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(5);

    if (lastOrdersError) throw lastOrdersError;

    lastFiveOrders = lastOrdersData || [];
    console.log('[admin] lastFiveOrders', lastFiveOrders);
  } catch (error) {
    console.error('[admin] failed to load last five orders', error);
  }

  // Calcul des 5 produits les plus vendus
  try {
    const { data: topProductsData, error: topProductsError } = await window.supabaseClient
      .from('commande_details')
      .select('produit_id, sum(qte) as total_qte')
      .group('produit_id')
      .order('total_qte', { ascending: false })
      .limit(5);

    if (topProductsError) throw topProductsError;

    topFiveProducts = topProductsData || [];
    console.log('[admin] topFiveProducts', topFiveProducts);
  } catch (error) {
    console.error('[admin] failed to load top five products', error);
  }
}

function attachAdminOrderFilters() {
  const filterButtons = document.querySelectorAll('[data-order-filter]');
  filterButtons.forEach((button) => {
    button.addEventListener('click', () => {
      adminOrderFilter = button.dataset.orderFilter;

      filterButtons.forEach((item) => {
        const isSelected = item === button;
        item.classList.toggle('btn-primary', isSelected);
        item.classList.toggle('btn-outline-secondary', !isSelected);
      });

      renderAdminOrdersList(adminOrdersCache);
    });
  });
}

async function initAdminPage() {
  if (!window.mcaAuth?.isConfigured()) {
    setAdminMessage(window.mcaAuth?.getConfigError() || 'Client Supabase indisponible.', true);
    return;
  }

  const loginForm = document.getElementById('admin-login-form');
  const productForm = document.getElementById('product-form');
  const searchInput = document.getElementById('admin-product-search');
  const cancelButton = document.getElementById('cancel-product-edit');
  const logoutButton = document.getElementById('admin-logout');
  const imageInput = document.getElementById('product-image-file');

  if (loginForm) loginForm.addEventListener('submit', handleAdminLogin);
  if (productForm) productForm.addEventListener('submit', saveProduct);
  if (searchInput) {
    searchInput.addEventListener('input', (event) => {
      const search = (event.target.value || '').trim().toLowerCase();
      const filtered = adminProducts.filter((product) => `${product.nom || ''} ${product.reference || ''} ${product.categorie || ''}`.toLowerCase().includes(search));
      renderAdminProducts(filtered);
    });
  }
  if (cancelButton) cancelButton.addEventListener('click', resetProductForm);
  if (logoutButton) logoutButton.addEventListener('click', handleAdminLogout);
  if (imageInput) imageInput.addEventListener('change', (event) => {
    const file = event.target.files[0];
    const preview = document.getElementById('product-image-preview');
    if (!file || !preview) return;
    preview.src = URL.createObjectURL(file);
    preview.hidden = false;
  });

  attachAdminOrderFilters();
  resetProductForm();

  const { data, error } = await window.mcaAuth.getUser();
  if (error) {
    console.error('[admin] getUser failed', error);
    setAdminMessage(error.message, true);
    showAdminLogin();
    return;
  }

  if (!data?.user) {
    showAdminLogin();
    setAdminMessage('Connectez-vous avec le compte administrateur.');
    return;
  }

  await openAdminDashboard(data.user);
  await loadAdminOrders();
}

window.addEventListener('DOMContentLoaded', initAdminPage);

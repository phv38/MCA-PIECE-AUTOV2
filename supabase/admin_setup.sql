ALTER TABLE public.produits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "produits_public_read" ON public.produits;
CREATE POLICY "produits_public_read"
  ON public.produits
  FOR SELECT
  TO anon, authenticated
  USING (true);

DROP POLICY IF EXISTS "produits_admin_manage" ON public.produits;
CREATE POLICY "produits_admin_manage"
  ON public.produits
  FOR ALL
  TO authenticated
  USING ((SELECT auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  WITH CHECK ((SELECT auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

CREATE OR REPLACE FUNCTION public.decrement_stock(product_id bigint, quantity integer)
RETURNS TABLE (
  produit_id bigint,
  nom text,
  stock_avant integer,
  stock_apres integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  current_product public.produits%ROWTYPE;
  next_stock integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentification requise pour décrémenter le stock.'
      USING ERRCODE = '42501';
  END IF;

  IF product_id IS NULL OR product_id <= 0 THEN
    RAISE EXCEPTION 'Produit invalide pour la décrémentation du stock.'
      USING ERRCODE = '22023';
  END IF;

  IF quantity IS NULL OR quantity <= 0 THEN
    RAISE EXCEPTION 'La quantité à décrémenter doit être strictement positive.'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
  INTO current_product
  FROM public.produits
  WHERE id = product_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Produit #% introuvable.', product_id
      USING ERRCODE = 'P0002';
  END IF;

  IF COALESCE(current_product.stock, 0) < quantity THEN
    RAISE EXCEPTION 'Stock insuffisant pour le produit "%" : disponible %, demandé %.', current_product.nom, COALESCE(current_product.stock, 0), quantity
      USING ERRCODE = 'P0001';
  END IF;

  next_stock := COALESCE(current_product.stock, 0) - quantity;

  UPDATE public.produits
  SET stock = next_stock
  WHERE id = product_id;

  RETURN QUERY
  SELECT
    current_product.id::bigint AS produit_id,
    current_product.nom::text AS nom,
    COALESCE(current_product.stock, 0)::integer AS stock_avant,
    next_stock::integer AS stock_apres;
END;
$$;

REVOKE ALL ON FUNCTION public.decrement_stock(bigint, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.decrement_stock(bigint, integer) TO authenticated;

ALTER TABLE public.commandes
  ADD COLUMN IF NOT EXISTS stock_journal JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.commandes
  ADD COLUMN IF NOT EXISTS stock_checked_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION public.create_order_with_stock(
  cart_items jsonb,
  order_total numeric,
  order_statut text DEFAULT 'En attente'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  current_user_id uuid := auth.uid();
  new_order public.commandes%ROWTYPE;
  item jsonb;
  item_product_id bigint;
  item_quantity integer;
  item_unit_price numeric;
  stock_result record;
  stock_journal_payload jsonb := '[]'::jsonb;
BEGIN
  IF current_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentification requise pour créer une commande.'
      USING ERRCODE = '42501';
  END IF;

  IF cart_items IS NULL OR jsonb_typeof(cart_items) <> 'array' OR jsonb_array_length(cart_items) = 0 THEN
    RAISE EXCEPTION 'Le panier est vide ou invalide.'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.commandes (user_id, total, statut, created_at)
  VALUES (current_user_id, COALESCE(order_total, 0), COALESCE(NULLIF(order_statut, ''), 'En attente'), NOW())
  RETURNING * INTO new_order;

  FOR item IN
    SELECT value
    FROM jsonb_array_elements(cart_items)
  LOOP
    item_product_id := COALESCE(
      NULLIF(item ->> 'id', ''),
      NULLIF(item ->> 'product_id', ''),
      NULLIF(item ->> 'produit_id', '')
    )::bigint;

    item_quantity := COALESCE(
      NULLIF(item ->> 'quantite', ''),
      NULLIF(item ->> 'quantity', '')
    )::integer;

    item_unit_price := COALESCE(
      NULLIF(item ->> 'prix', ''),
      NULLIF(item ->> 'price', ''),
      '0'
    )::numeric;

    IF item_product_id IS NULL OR item_product_id <= 0 THEN
      RAISE EXCEPTION 'Produit invalide dans le panier.'
        USING ERRCODE = '22023';
    END IF;

    IF item_quantity IS NULL OR item_quantity <= 0 THEN
      RAISE EXCEPTION 'Quantité invalide pour le produit %.', item_product_id
        USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.commande_details (commande_id, produit_id, quantite, prix)
    VALUES (new_order.id, item_product_id, item_quantity, item_unit_price);

    SELECT *
    INTO stock_result
    FROM public.decrement_stock(item_product_id, item_quantity);

    stock_journal_payload := stock_journal_payload || jsonb_build_array(
      jsonb_build_object(
        'product_id', stock_result.produit_id,
        'nom', stock_result.nom,
        'quantity', item_quantity,
        'stock_avant', stock_result.stock_avant,
        'stock_apres', stock_result.stock_apres,
        'checked_at', NOW()
      )
    );
  END LOOP;

  UPDATE public.commandes
  SET stock_journal = stock_journal_payload,
      stock_checked_at = NOW()
  WHERE id = new_order.id
  RETURNING * INTO new_order;

  RETURN jsonb_build_object(
    'order', to_jsonb(new_order),
    'stock_journal', stock_journal_payload
  );
END;
$$;

REVOKE ALL ON FUNCTION public.create_order_with_stock(jsonb, numeric, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_order_with_stock(jsonb, numeric, text) TO authenticated;
NOTIFY pgrst, 'reload schema';

INSERT INTO storage.buckets (id, name, public)
VALUES ('product-images', 'product-images', true)
ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public;

INSERT INTO storage.buckets (id, name, public)
VALUES ('factures', 'factures', false)
ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public;

DROP POLICY IF EXISTS "product_images_public_read" ON storage.objects;
CREATE POLICY "product_images_public_read"
  ON storage.objects
  FOR SELECT
  TO public
  USING (bucket_id = 'product-images');

DROP POLICY IF EXISTS "product_images_admin_insert" ON storage.objects;
CREATE POLICY "product_images_admin_insert"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'product-images'
    AND (SELECT auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
  );

DROP POLICY IF EXISTS "product_images_admin_update" ON storage.objects;
CREATE POLICY "product_images_admin_update"
  ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'product-images'
    AND (SELECT auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
  )
  WITH CHECK (
    bucket_id = 'product-images'
    AND (SELECT auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
  );

DROP POLICY IF EXISTS "product_images_admin_delete" ON storage.objects;
CREATE POLICY "product_images_admin_delete"
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'product-images'
    AND (SELECT auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
  );

DROP POLICY IF EXISTS "invoices_select_owner_or_admin" ON storage.objects;
CREATE POLICY "invoices_select_owner_or_admin"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'factures'
    AND (
      ((storage.foldername(name))[1] = auth.uid()::text)
      OR EXISTS (
        SELECT 1
        FROM public.profils
        WHERE id = auth.uid()
          AND lower(coalesce(role, '')) = 'admin'
      )
    )
  );

DROP POLICY IF EXISTS "invoices_insert_owner_or_admin" ON storage.objects;
CREATE POLICY "invoices_insert_owner_or_admin"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'factures'
    AND (
      ((storage.foldername(name))[1] = auth.uid()::text)
      OR EXISTS (
        SELECT 1
        FROM public.profils
        WHERE id = auth.uid()
          AND lower(coalesce(role, '')) = 'admin'
      )
    )
  );

DROP POLICY IF EXISTS "invoices_update_owner_or_admin" ON storage.objects;
CREATE POLICY "invoices_update_owner_or_admin"
  ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'factures'
    AND (
      ((storage.foldername(name))[1] = auth.uid()::text)
      OR EXISTS (
        SELECT 1
        FROM public.profils
        WHERE id = auth.uid()
          AND lower(coalesce(role, '')) = 'admin'
      )
    )
  )
  WITH CHECK (
    bucket_id = 'factures'
    AND (
      ((storage.foldername(name))[1] = auth.uid()::text)
      OR EXISTS (
        SELECT 1
        FROM public.profils
        WHERE id = auth.uid()
          AND lower(coalesce(role, '')) = 'admin'
      )
    )
  );

DROP POLICY IF EXISTS "invoices_delete_owner_or_admin" ON storage.objects;
CREATE POLICY "invoices_delete_owner_or_admin"
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'factures'
    AND (
      ((storage.foldername(name))[1] = auth.uid()::text)
      OR EXISTS (
        SELECT 1
        FROM public.profils
        WHERE id = auth.uid()
          AND lower(coalesce(role, '')) = 'admin'
      )
    )
  );

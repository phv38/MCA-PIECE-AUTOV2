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
NOTIFY pgrst, 'reload schema';

INSERT INTO storage.buckets (id, name, public)
VALUES ('product-images', 'product-images', true)
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

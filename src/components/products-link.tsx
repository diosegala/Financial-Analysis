import { Link } from "@tanstack/react-router";
import { Package } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Atalho para o catálogo de produtos, que saiu do menu: ele serve a Receitas e Eventos. */
export function ProductsLink() {
  return (
    <Button asChild size="sm" variant="outline" className="gap-1.5">
      <Link to="/produtos" search={(prev: Record<string, unknown>) => prev}>
        <Package className="h-4 w-4" /> Produtos
      </Link>
    </Button>
  );
}

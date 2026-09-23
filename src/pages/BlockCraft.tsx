import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { CraftApp } from "@/craft/ui/CraftApp";

/**
 * BlockCraft — the block-building survival game, full screen over the app.
 * Everything it draws is painted by code in src/craft, so it needs no asset
 * downloads and works offline once the page has loaded.
 */
export default function BlockCraft() {
  const navigate = useNavigate();
  useEffect(() => {
    const before = document.title;
    document.title = "BlockCraft · SAS-JACKY";
    return () => { document.title = before; };
  }, []);
  return <CraftApp onExit={() => navigate("/")} />;
}

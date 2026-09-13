import React, { useEffect, useState } from 'react';

export function ShelfMenuEdgeShade() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const update = () => setScrolled(window.scrollY > 0);
    update();
    window.addEventListener('scroll', update, { passive: true });
    return () => window.removeEventListener('scroll', update);
  }, []);

  return <div className="shelf-menu-edge-shade" data-scrolled={scrolled} aria-hidden="true" />;
}

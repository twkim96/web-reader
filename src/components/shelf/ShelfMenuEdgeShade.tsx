import React, { useEffect, useState } from 'react';

export function ShelfMenuEdgeShade() {
  const [edges, setEdges] = useState({ top: false, bottom: false });

  useEffect(() => {
    const update = () => {
      const scrollRoot = document.scrollingElement ?? document.documentElement;
      const top = window.scrollY > 1;
      const bottom = scrollRoot.scrollHeight - window.innerHeight - Math.max(0, window.scrollY) > 1;
      setEdges(previous => previous.top === top && previous.bottom === bottom ? previous : { top, bottom });
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(document.documentElement);
    observer?.observe(document.body);
    return () => {
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      observer?.disconnect();
    };
  }, []);

  return <>
    <div className="shelf-menu-edge-shade" data-edge="top" data-visible={edges.top} aria-hidden="true" />
    <div className="shelf-menu-edge-shade" data-edge="bottom" data-visible={edges.bottom} aria-hidden="true" />
  </>;
}

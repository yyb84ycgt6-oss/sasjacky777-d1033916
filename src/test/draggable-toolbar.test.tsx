import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { DraggableToolbar } from "@/components/DraggableToolbar";

/**
 * The floating toolbars open at a guessed position — `innerWidth - 320` — while
 * the nav bar is actually ~370px wide once its grip and padding are counted, so
 * the app opened with a strip of it hanging off the right edge of the screen and
 * two of its buttons unreachable. A stored position from a wider window did the
 * same. clamp() existed but only ran mid-drag, which is exactly when the toolbar
 * is already on screen.
 *
 * These render the toolbar with a known size and assert it always lands fully
 * inside the viewport, including from a saved position that no longer fits.
 */
const SIZES = { width: 370, height: 56 };

function box(el: HTMLElement) {
  return { left: parseFloat(el.style.left), top: parseFloat(el.style.top) };
}

function toolbarEl() {
  return screen.getByLabelText("Hold to drag toolbar").parentElement as HTMLElement;
}

describe("DraggableToolbar placement", () => {
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: SIZES.width });
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: SIZES.height });
  });

  afterEach(() => {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetWidth;
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetHeight;
    localStorage.clear();
  });

  it("opens fully inside the viewport rather than off the right edge", () => {
    render(<DraggableToolbar storageKey="test.toolbar.a"><span>bar</span></DraggableToolbar>);
    const { left, top } = box(toolbarEl());
    expect(left).toBeGreaterThanOrEqual(0);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(left + SIZES.width).toBeLessThanOrEqual(window.innerWidth);
    expect(top + SIZES.height).toBeLessThanOrEqual(window.innerHeight);
  });

  it("pulls a stored position that no longer fits back on screen", () => {
    localStorage.setItem("test.toolbar.b", JSON.stringify({ x: 4000, y: 3000 }));
    render(<DraggableToolbar storageKey="test.toolbar.b"><span>bar</span></DraggableToolbar>);
    const { left, top } = box(toolbarEl());
    expect(left + SIZES.width).toBeLessThanOrEqual(window.innerWidth);
    expect(top + SIZES.height).toBeLessThanOrEqual(window.innerHeight);
  });

  it("gives a second toolbar its own row so neither covers the other", () => {
    const { unmount } = render(
      <DraggableToolbar storageKey="test.toolbar.row0"><span>first</span></DraggableToolbar>,
    );
    const first = box(toolbarEl());
    unmount();

    render(
      <DraggableToolbar storageKey="test.toolbar.row1" defaultRow={1}><span>second</span></DraggableToolbar>,
    );
    const second = box(toolbarEl());

    expect(second.top).toBeLessThan(first.top);
    expect(first.top - second.top).toBeGreaterThanOrEqual(SIZES.height);
  });
});

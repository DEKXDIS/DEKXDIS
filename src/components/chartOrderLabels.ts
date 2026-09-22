import type { ISeriesPrimitive, IPrimitivePaneView, SeriesAttachedParameter } from 'lightweight-charts';

export const shortChartId = (id: string) => id.length > 6 ? `…${id.slice(-6)}` : id;
type Label = { price: number; title: string; color: string };

/** Draw order details in the plot, independently of the right-hand price axis. */
export class ChartOrderLabels implements ISeriesPrimitive {
  private attachedTo?: SeriesAttachedParameter;
  private labels: Label[] = [];
  private views: IPrimitivePaneView[] = [{
    zOrder: () => 'top',
    renderer: () => ({ draw: target => target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      ctx.save();
      ctx.font = '11px monospace';
      ctx.textBaseline = 'middle';
      for (const label of this.labels) {
        const y = this.attachedTo?.series.priceToCoordinate(label.price);
        if (y == null || y < 10 || y > mediaSize.height - 10) continue;
        const width = Math.min(ctx.measureText(label.title).width + 12, mediaSize.width - 12);
        ctx.fillStyle = '#0d111a';
        ctx.fillRect(4, y - 9, width, 18);
        ctx.fillStyle = label.color;
        ctx.fillText(label.title, 10, y, Math.max(1, width - 12));
      }
      ctx.restore();
    }) }),
  }];
  attached(params: SeriesAttachedParameter) { this.attachedTo = params; }
  detached() { this.attachedTo = undefined; }
  paneViews() { return this.views; }
  setLabels(labels: Label[]) { this.labels = labels; this.attachedTo?.requestUpdate(); }
}

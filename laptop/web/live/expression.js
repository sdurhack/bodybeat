// bodybeat's custom face-expression model, trained in model/train_expression.ipynb
// (FER2013 faces + Microsoft's FER+ labels). It gives the same 7 labels as face-api, so
// fusion.js and the UNO Q don't care which model answered.
//
// Runs on the tf.js that face-api already bundles, using only basic ops (conv, depthwise conv,
// max pool, mean, matMul), so no extra library and no model-format converter is needed.
// Files (from the notebook's zip, in live/model/):
//   expression_model.json        the layer list, labels and the notebook's test results
//   expression_model.bin         weights, 8-bit (batch-norm already folded into the convs)
//   expression_model_check.json  8 test faces + the answers Python got: checked on load

export const LABELS = ["neutral", "happy", "sad", "angry", "fearful", "disgusted", "surprised"];

export class OwnExpressionNet {
  constructor(tf, base = "live/model") {
    this.tf = tf; this.base = base;
    this.ops = null; this.size = 48; this.flip = false; this.info = null; this.check = null;
    this.margin = 0.15;   // grow face-api's box by this on each side, closer to how FER2013 faces are cropped
  }

  async load() {
    const get = async (f, kind) => {
      const r = await fetch(`${this.base}/${f}`);
      if (!r.ok) throw new Error(`${f}: ${r.status} (run the notebook and unzip its files into live/model/)`);
      return kind === "json" ? r.json() : r.arrayBuffer();
    };
    const [man, buf] = await Promise.all([get("expression_model.json", "json"), get("expression_model.bin", "bin")]);
    if (man.format !== "bodyband-expr-1") throw new Error("unknown model format " + man.format);
    if (JSON.stringify(man.labels) !== JSON.stringify(LABELS)) throw new Error("model labels differ from face-api's");
    this.ops = man.ops.map((o) => ({ op: o.op, w: o.w && this.tensor(o.w, buf), b: o.b && this.tensor(o.b, buf) }));
    this.size = man.input[0]; this.flip = !!man.flip_tta; this.info = man.test_results || null;
    try { this.check = this.selfTest(await get("expression_model_check.json", "json")); } catch { this.check = null; }
    return this;
  }

  tensor(d, buf) {
    const n = d.shape.reduce((a, b) => a * b, 1);
    let v;
    if (d.dtype === "uint8") {
      const q = new Uint8Array(buf, d.offset, n);
      v = new Float32Array(n);
      for (let i = 0; i < n; i++) v[i] = d.min + q[i] * d.scale;
    } else v = new Float32Array(buf.slice(d.offset, d.offset + 4 * n));
    return this.tf.tensor(v, d.shape);
  }

  // x: [n, 48, 48, 1], pixels 0..1  ->  logits [n, 7]
  forward(x) {
    const tf = this.tf;
    for (const o of this.ops) {
      if (o.op === "conv") x = tf.relu(tf.add(tf.conv2d(x, o.w, 1, "same"), o.b));
      else if (o.op === "dwconv") x = tf.relu(tf.add(tf.depthwiseConv2d(x, o.w, 1, "same"), o.b));
      else if (o.op === "maxpool") x = tf.maxPool(x, 2, 2, "valid");
      else if (o.op === "gap") x = tf.mean(x, [1, 2]);
      else if (o.op === "dense") x = tf.add(tf.matMul(x, o.w), o.b);
      else throw new Error("unknown op " + o.op);
    }
    return x;
  }

  // probabilities [n, 7]; with flip, averaged with the mirrored face (the notebook decides)
  probs(x, flip = this.flip) {
    const tf = this.tf;
    let p = tf.softmax(this.forward(x));
    if (flip) p = tf.div(tf.add(p, tf.softmax(this.forward(tf.reverse(x, 2)))), 2);
    return p;
  }

  // source: canvas or video; box: face-api's {x, y, width, height} in the source's pixels
  async predict(source, box) {
    const tf = this.tf, S = this.size;
    const p = tf.tidy(() => {
      const img = tf.browser.fromPixels(source);
      const [H, W] = img.shape;
      const side = Math.max(box.width, box.height) * (1 + 2 * this.margin);
      const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
      const crop = tf.image.cropAndResize(tf.expandDims(tf.cast(img, "float32"), 0),
        [[(cy - side / 2) / H, (cx - side / 2) / W, (cy + side / 2) / H, (cx + side / 2) / W]], [0], [S, S]);
      const grey = tf.div(tf.sum(tf.mul(crop, tf.tensor1d([0.299, 0.587, 0.114])), -1, true), 255);
      return this.probs(grey);
    });
    const v = await p.data();
    p.dispose();
    return Object.fromEntries(LABELS.map((k, i) => [k, v[i]]));
  }

  // runs the notebook's 8 test faces; returns the largest difference from Python's answers
  selfTest(chk) {
    const tf = this.tf, S = this.size;
    const out = tf.tidy(() => {
      const x = tf.div(tf.tensor(chk.faces.flat(), [chk.faces.length, S, S, 1]), 255);
      return this.probs(x, false).arraySync();
    });
    let worst = 0;
    out.forEach((row, i) => row.forEach((v, j) => { worst = Math.max(worst, Math.abs(v - chk.expected[i][j])); }));
    return { maxDiff: worst, ok: worst < 0.01 };
  }
}

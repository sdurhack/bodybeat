# bodybeat custom face-expression model

A small custom model that reads the expression on a face, to replace face-api's expression model in
`laptop/web/live.html`. face-api still finds the face; the custom model reads the expression on it.

## What it is

- **Data:** FER2013 (35,887 greyscale faces, 48x48) with Microsoft's [FER+](https://github.com/microsoft/FERPlus)
  labels: 10 people voted on every face, and we train on the share of votes (soft labels), not one hard label.
  Faces the voters called "not a face" or "unknown" are dropped. FER+ "contempt" is rare, so it counts as "disgusted".
- **Model:** a small depthwise-separable CNN (MobileNet-style), about 110k weights. Batch norm is folded into the convs,
  and the weights are stored in 8 bits, so the file is around 110 KB (face-api's expression model is 322 KB).
- **Output:** the same 7 labels as face-api (`neutral happy sad angry fearful disgusted surprised`), so `fusion.js`
  and the UNO Q need no changes.
- **Browser:** `live/expression.js` runs it with plain tf.js ops (conv, depthwise conv, max pool, mean, matMul) on
  the tf.js that face-api already loads. It crops face-api's box with a 15% margin, turns it grey and resizes it to 48x48.

## Train it (Google Colab, about 15-25 minutes on the free GPU)

1. Open `train_expression.ipynb` in [Colab](https://colab.research.google.com) (*File > Upload notebook*).
2. *Runtime > Change runtime type > T4 GPU*, then *Runtime > Run all*.
3. Sign in to Kaggle when the download cell asks (FER2013 comes from Kaggle).
4. At the end it downloads `bodyband_expression_model.zip`. Unzip it into `laptop/web/live/model/`.

## Is it as good as face-api?

The notebook runs **both** models on the same FER+ test faces (3,500+ faces neither model trained on), and reports:

| Measure | Meaning |
|---|---|
| 7 expressions | top expression matches the voters' top expression |
| 3 key groups | the key it would pick (C major / D dorian / A minor) matches the voters'. This is the number that matters for the band |
| agreement | how often the custom model and face-api pick the same key |

Then it is checked on real faces:

1. Run the conductor, open http://127.0.0.1:8000/live.html.
2. Set **Expression model** (Nicla card) to **Compare both**. face-api still decides the key; the page shows both answers
   and "same key as face-api on N% of M faces", plus the custom model's milliseconds per face.
3. Switch to **Custom model** only when it holds up. If the model files are missing or fail their self-check, the page
   says so in the log and goes back to face-api by itself.

`laptop/web/expression_check.html` checks the browser code against the notebook: it runs 8 test faces through
`expression.js` and compares with Python's answers (served by the conductor at `/expression_check.html`).

## Results

FER+ test set (PrivateTest, faces neither model trained on), trained 2026-11-17 on a Colab T4:

| | 7 expressions | 3 key groups | model file |
|---|---|---|---|
| face-api `faceExpressionNet` | 64.7% | 73.3% | 322 KB |
| **custom model** (8-bit, + mirrored pass) | **79.8%** | **83.3%** | **109 KB** |

Per expression (custom / face-api): neutral 90 / 55, happy 86 / 82, surprised 83 / 77, angry 81 / 60,
sad 53 / 55, fearful 34 / 45, disgusted 9 / 47. The two pick the same key on 77% of test faces.

Fair warning on these numbers: face-api was trained on larger colour photos, so 48x48 grey faces handicap it,
and the custom model was trained on the same kind of faces it is tested on. It is weak on disgusted and fearful (rare in
FER+), but both count as A minor, like angry and sad, so the key barely suffers. The live comparison on real faces
through the Nicla is the test that decides.

## Licences

FER+ labels: MIT (Microsoft). FER2013 images: from the 2013 Kaggle/ICML challenge, for research use; we publish
only the trained weights, not the images. face-api: MIT (in `laptop/web/live/vendor/`).

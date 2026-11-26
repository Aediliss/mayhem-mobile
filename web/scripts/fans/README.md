# FANS-1/A schema for `src/dsp/cpdlc/fans.ts` (FORK)

`fans.ts` is generated. To regenerate it against a newer libacars:

1. Build and install libacars (https://github.com/szpajder/libacars, MIT).
2. Compile `dump.c` together with libacars' `libacars/asn1/*.c`, which are asn1c output (asn1c runtime: BSD-2-Clause):

   ```bash
   gcc -w -I$LA/libacars/asn1 -I$LA -I$LA/build -I/usr/local/include/libacars-2 dump.c $LA/libacars/asn1/*.c -o dump -lm -lacars-2
   ```

3. Dump the schema: `./dump > schema.json`. It walks the descriptors of `FANSATCUplinkMessage` and
   `FANSATCDownlinkMessage` and records types, PER constraints, alphabets, CHOICE canonical order and enumerations.
4. Generate the module: `python3 gen.py <dir of schema.json> $LA/libacars src/dsp/cpdlc/fans.ts`. This adds the element
   phrases, labels and units from `asn1-format-cpdlc-text.c`.

`gen.py` stops on any ASN.1 extension marker or extensible constraint, because the decoder does not implement them.

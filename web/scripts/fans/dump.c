/* Walks asn1c's FANS-1/A descriptors (libacars, MIT; asn1c runtime BSD-2) and prints the UPER-relevant schema as JSON. */
#include <stdio.h>
#include <string.h>
#include "FANSATCUplinkMessage.h"
#include "FANSATCDownlinkMessage.h"
#include "constr_SEQUENCE.h"
#include "constr_CHOICE.h"
#include "constr_SET_OF.h"
#include "INTEGER.h"
#include "NativeInteger.h"
#include "NativeEnumerated.h"
#include "BOOLEAN.h"
#include "NULL.h"
#include "OCTET_STRING.h"
#include "BIT_STRING.h"
static asn_TYPE_descriptor_t *seen[4096]; static int nseen = 0;
static int idOf(asn_TYPE_descriptor_t *td) { for (int i = 0; i < nseen; i++) if (seen[i] == td) return i; seen[nseen] = td; return nseen++; }
static void resolve(asn_TYPE_descriptor_t *td) { for (int k = 0; k < 10; k++) { void *before = (void *)td->uper_decoder; td->free_struct(td, NULL, 0); if ((void *)td->uper_decoder == before) break; } }
static const char *kind(asn_TYPE_descriptor_t *td) {
  per_type_decoder_f *f = td->uper_decoder;
  if (f == SEQUENCE_decode_uper) return "seq"; if (f == CHOICE_decode_uper) return "choice"; if (f == SET_OF_decode_uper) return "seqof";
  if (f == NativeInteger_decode_uper) return "int"; if (f == INTEGER_decode_uper) return "int"; if (f == NativeEnumerated_decode_uper) return "enum";
  if (f == BOOLEAN_decode_uper) return "bool"; if (f == NULL_decode_uper) return "null"; if (f == OCTET_STRING_decode_uper) return "str";
  return "unknown";
}
static void pc1(const char *k, const asn_per_constraint_t *c) { printf("\"%s\":[%d,%d,%d,%ld,%ld]", k, c->flags, c->range_bits, c->effective_bits, c->lower_bound, c->upper_bound); }
static void pcs(asn_per_constraints_t *pc) {
  if (!pc) { printf("null"); return; }
  printf("{"); pc1("v", &pc->value); printf(","); pc1("s", &pc->size);
  if (pc->code2value && pc->value.range_bits > 0 && pc->value.range_bits <= 8) { printf(",\"alpha\":["); for (int c = 0; c < (1 << pc->value.range_bits); c++) printf("%s%d", c ? "," : "", pc->code2value(c)); printf("]"); }
  printf("}");
}
static void dump(asn_TYPE_descriptor_t *td) {
  resolve(td);
  const char *k = kind(td);
  printf("{\"id\":%d,\"name\":\"%s\",\"kind\":\"%s\",\"pc\":", idOf(td), td->name, k); pcs(td->per_constraints);
  if (!strcmp(k, "seq")) { asn_SEQUENCE_specifics_t *s = (asn_SEQUENCE_specifics_t *)td->specifics; printf(",\"extAfter\":%d,\"extBefore\":%d,\"roms\":%d,\"aoms\":%d", s->ext_after, s->ext_before, s->roms_count, s->aoms_count); }
  if (!strcmp(k, "choice")) { asn_CHOICE_specifics_t *s = (asn_CHOICE_specifics_t *)td->specifics; printf(",\"extStart\":%d,\"canon\":", s->ext_start); if (s->canonical_order) { printf("["); for (int i = 0; i < td->elements_count; i++) printf("%s%d", i ? "," : "", s->canonical_order[i]); printf("]"); } else printf("null"); }
  if (!strcmp(k, "enum")) { asn_INTEGER_specifics_t *s = (asn_INTEGER_specifics_t *)td->specifics; printf(",\"ext\":%d,\"values\":[", s->extension); for (int i = 0; i < s->map_count; i++) printf("%s[%ld,\"%s\"]", i ? "," : "", s->value2enum[i].nat_value, s->value2enum[i].enum_name); printf("]"); }
  if (!strcmp(k, "str")) { asn_OCTET_STRING_specifics_t *s = td->specifics ? (asn_OCTET_STRING_specifics_t *)td->specifics : NULL; if (!s) { printf(",\"sub\":-1"); } else printf(",\"sub\":%d", s->subvariant); }
  printf(",\"members\":[");
  if (strcmp(k, "str") && strcmp(k, "int") && strcmp(k, "enum")) for (int i = 0; i < td->elements_count; i++) {
    asn_TYPE_member_t *m = &td->elements[i];
    resolve(m->type);
    printf("%s{\"name\":\"%s\",\"opt\":%d,\"type\":%d,\"pc\":", i ? "," : "", m->name, m->optional, idOf(m->type)); pcs(m->per_constraints); printf("}");
  }
  printf("]}");
}
int main(void) {
  idOf(&asn_DEF_FANSATCUplinkMessage); idOf(&asn_DEF_FANSATCDownlinkMessage);
  printf("[\n");
  for (int i = 0; i < nseen; i++) { if (i) printf(",\n"); dump(seen[i]); }
  printf("\n]\n");
}

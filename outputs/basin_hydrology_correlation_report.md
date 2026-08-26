# Basin-by-basin land cover / hydrology correlation report

Land cover: Esri 10m Annual LULC, 2017-2025. Hydrology: api.meteo.lt historical archive, most-downstream in-basin station per basin's main river -- the gauge closest to the basin's estimated outlet, since that integrates the whole basin's catchment (method + caveats: see the docstring of basin_hydrology_correlation.py). Annual hydrology values are an unweighted average of monthly means (each month needs >=20 valid days, each year needs >=11 valid months), which avoids overweighting whichever season happened to report more complete data. Correlations are Pearson (linear) and Spearman (monotonic/rank), computed per land-cover class against the station's annual discharge or water-level mean, paired by year. p-values are from a paired permutation test (exact for n<=8, Monte Carlo otherwise); q-values are Benjamini-Hochberg FDR-adjusted across the 5 land-cover classes tested per river unit. Sample sizes are small (Esri only spans 9 years, and station coverage trims that further) -- treat every result here as indicative, not statistically conclusive. Several gauges sit on rivers whose real catchment extends well beyond Lithuania's borders (see 'Caveat' notes below); for those, basin land cover explains only part of the flow by physical necessity.

## Nemuno mažieji intakai — Nemunas
*Skipped: no observations returned*

## Merkys — Merkys
*Caveat: Part of the catchment lies upstream in Belarus.*
- Station: **Puvočių VMS** (`puvociu-vms`), 31.7 km from the basin's estimated outlet along a 196.9 km mapped reach.
- Hydrology metric used: **discharge** (8 usable years out of 9).
- Years used: 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024 (n=8)

| Class | Pearson r | Pearson p | Pearson q (FDR) | Spearman r | Spearman p | Spearman q (FDR) |
|---|---|---|---|---|---|---|
| Water | 0.343 | 0.4133 | 0.5786 | 0.190 | 0.6646 | 0.7520 |
| Wetland | 0.533 | 0.1714 | 0.4311 | 0.595 | 0.1323 | 0.6615 |
| Urban | -0.561 | 0.1724 | 0.4311 | 0.143 | 0.7520 | 0.7520 |
| Agriculture | -0.240 | 0.5786 | 0.5786 | -0.310 | 0.4618 | 0.7520 |
| Forest | 0.303 | 0.4749 | 0.5786 | 0.310 | 0.4618 | 0.7520 |

## Šešupė — Šešupė
*Note: fragmented river line; using longest component.*
*Caveat: Part of the catchment lies upstream in Poland.*
- Station: **Kudirkos Naumiesčio VMS** (`kudirkos-naumiescio-vms`), 67.0 km from the basin's estimated outlet along a 156.5 km mapped reach.
- Hydrology metric used: **discharge** (7 usable years out of 9).
- Years used: 2017, 2018, 2019, 2020, 2021, 2022, 2023 (n=7)

| Class | Pearson r | Pearson p | Pearson q (FDR) | Spearman r | Spearman p | Spearman q (FDR) |
|---|---|---|---|---|---|---|
| Water | -0.079 | 0.8556 | 0.8556 | 0.071 | 0.9063 | 1.0000 |
| Wetland | 0.735 | 0.0573 | 0.2867 | 0.821 | 0.0341 | 0.1706 |
| Urban | -0.589 | 0.1617 | 0.4043 | -0.250 | 0.5948 | 1.0000 |
| Agriculture | -0.347 | 0.4724 | 0.5905 | -0.143 | 0.7825 | 1.0000 |
| Forest | 0.388 | 0.4067 | 0.5905 | 0.000 | 1.0000 | 1.0000 |

## Neris — Neris
*Caveat: Roughly 70% of the catchment lies in Belarus.*
- Station: **Jonavos VMS** (`jonavos-vms`), 28.1 km from the basin's estimated outlet along a 231.1 km mapped reach.
- Hydrology metric used: **discharge** (8 usable years out of 9).
- Years used: 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024 (n=8)

| Class | Pearson r | Pearson p | Pearson q (FDR) | Spearman r | Spearman p | Spearman q (FDR) |
|---|---|---|---|---|---|---|
| Water | 0.635 | 0.0943 | 0.1900 | 0.095 | 0.8401 | 0.9349 |
| Wetland | -0.000 | 0.9992 | 0.9992 | 0.048 | 0.9349 | 0.9349 |
| Urban | -0.351 | 0.3937 | 0.4922 | 0.143 | 0.7520 | 0.9349 |
| Agriculture | -0.599 | 0.1140 | 0.1900 | -0.833 | 0.0154 | 0.0698 |
| Forest | 0.806 | 0.0152 | 0.0760 | 0.786 | 0.0279 | 0.0698 |

## Žeimena — Žeimena
*Note: fragmented river line; using longest component.*
- Station: **Pabradės VMS** (`pabrades-vms`), 2.6 km from the basin's estimated outlet along a 84.8 km mapped reach.
- Hydrology metric used: **discharge** (1 usable years out of 9).
- Fewer than 3 overlapping years -- correlation not computed.

## Minija — Minija
- Station: **Lankupių VMS** (`lankupiu-minija-vms`), 17.3 km from the basin's estimated outlet along a 197.0 km mapped reach.
- Hydrology metric used: **discharge** (8 usable years out of 9).
- Years used: 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024 (n=8)

| Class | Pearson r | Pearson p | Pearson q (FDR) | Spearman r | Spearman p | Spearman q (FDR) |
|---|---|---|---|---|---|---|
| Water | -0.535 | 0.1603 | 0.2672 | -0.119 | 0.7930 | 0.8820 |
| Wetland | 0.687 | 0.0399 | 0.1994 | 0.714 | 0.0576 | 0.2875 |
| Urban | -0.713 | 0.1148 | 0.2672 | 0.071 | 0.8820 | 0.8820 |
| Agriculture | 0.358 | 0.3882 | 0.4853 | 0.619 | 0.1150 | 0.2875 |
| Forest | -0.108 | 0.8469 | 0.8469 | -0.524 | 0.1966 | 0.3277 |

## Šventoji — Šventoji
*Note: fragmented river line; using longest component.*
- Station: **Ukmergės VMS** (`ukmerges-vms`), 16.6 km from the basin's estimated outlet along a 204.1 km mapped reach.
- Hydrology metric used: **discharge** (7 usable years out of 9).
- Years used: 2017, 2018, 2019, 2020, 2021, 2022, 2023 (n=7)

| Class | Pearson r | Pearson p | Pearson q (FDR) | Spearman r | Spearman p | Spearman q (FDR) |
|---|---|---|---|---|---|---|
| Water | 0.555 | 0.2056 | 0.2569 | 0.536 | 0.2357 | 0.3929 |
| Wetland | 0.801 | 0.0442 | 0.0737 | 0.214 | 0.6615 | 0.8269 |
| Urban | -0.353 | 0.4319 | 0.4319 | -0.107 | 0.8397 | 0.8397 |
| Agriculture | -0.803 | 0.0272 | 0.0737 | -0.786 | 0.0480 | 0.2202 |
| Forest | 0.781 | 0.0349 | 0.0737 | 0.714 | 0.0881 | 0.2202 |

## Dubysa — Dubysa
*Note: fragmented river line; using longest component.*
- Station: **Padubysio VMS** (`padubysio-vms`), 4.3 km from the basin's estimated outlet along a 119.0 km mapped reach.
- Hydrology metric used: **discharge** (8 usable years out of 9).
- Years used: 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024 (n=8)

| Class | Pearson r | Pearson p | Pearson q (FDR) | Spearman r | Spearman p | Spearman q (FDR) |
|---|---|---|---|---|---|---|
| Water | 0.115 | 0.7694 | 0.9860 | 0.000 | 1.0000 | 1.0000 |
| Wetland | 0.585 | 0.1460 | 0.7302 | 0.381 | 0.3599 | 0.9913 |
| Urban | -0.008 | 0.9860 | 0.9860 | -0.119 | 0.7930 | 0.9913 |
| Agriculture | 0.053 | 0.9359 | 0.9860 | -0.214 | 0.6191 | 0.9913 |
| Forest | -0.087 | 0.8613 | 0.9860 | 0.286 | 0.5008 | 0.9913 |

## Jūra — Jūra
*Note: fragmented river line; using longest component.*
- Station: **Tauragės VMS** (`taurages-vms`), 4.3 km from the basin's estimated outlet along a 160.6 km mapped reach.
- Hydrology metric used: **discharge** (8 usable years out of 9).
- Years used: 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024 (n=8)

| Class | Pearson r | Pearson p | Pearson q (FDR) | Spearman r | Spearman p | Spearman q (FDR) |
|---|---|---|---|---|---|---|
| Water | -0.349 | 0.4150 | 0.6916 | -0.238 | 0.5821 | 0.7930 |
| Wetland | 0.724 | 0.0563 | 0.2540 | 0.476 | 0.2431 | 0.7930 |
| Urban | -0.626 | 0.1016 | 0.2540 | -0.119 | 0.7930 | 0.7930 |
| Agriculture | 0.077 | 0.8606 | 0.8606 | 0.310 | 0.4618 | 0.7930 |
| Forest | 0.109 | 0.8104 | 0.8606 | -0.143 | 0.7520 | 0.7930 |

## Nevėžis — Nevėžis
- Station: **Babtų VMS** (`babtu-vms`), 14.5 km from the basin's estimated outlet along a 194.0 km mapped reach.
- Hydrology metric used: **discharge** (8 usable years out of 9).
- Years used: 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024 (n=8)

| Class | Pearson r | Pearson p | Pearson q (FDR) | Spearman r | Spearman p | Spearman q (FDR) |
|---|---|---|---|---|---|---|
| Water | 0.673 | 0.0606 | 0.1515 | 0.690 | 0.0694 | 0.2405 |
| Wetland | 0.832 | 0.0159 | 0.0794 | 0.643 | 0.0962 | 0.2405 |
| Urban | -0.498 | 0.2090 | 0.3483 | -0.119 | 0.7930 | 0.7930 |
| Agriculture | -0.228 | 0.5928 | 0.5928 | -0.286 | 0.5008 | 0.6260 |
| Forest | 0.226 | 0.5919 | 0.5928 | 0.286 | 0.5008 | 0.6260 |

## Nevėžis — Šušvė
- Station: **Šiaulėnų VMS** (`siaulenu-vms`), 8.8 km from the basin's estimated outlet along a 121.0 km mapped reach.
- Hydrology metric used: **discharge** (1 usable years out of 9).
- Fewer than 3 overlapping years -- correlation not computed.

## Lielupės mažieji intakai — Švėtė
*Note: fragmented river line; using longest component.*
- Station: **Žagarės VMS** (`zagares-vms`), 2.7 km from the basin's estimated outlet along a 19.5 km mapped reach.
- Hydrology metric used: **discharge** (7 usable years out of 9).
- Years used: 2017, 2018, 2019, 2020, 2021, 2022, 2023 (n=7)

| Class | Pearson r | Pearson p | Pearson q (FDR) | Spearman r | Spearman p | Spearman q (FDR) |
|---|---|---|---|---|---|---|
| Water | 0.487 | 0.2702 | 0.4504 | 0.464 | 0.3024 | 0.5040 |
| Wetland | 0.258 | 0.6435 | 0.6435 | 0.321 | 0.4976 | 0.6220 |
| Urban | -0.216 | 0.6177 | 0.6435 | -0.143 | 0.7825 | 0.7825 |
| Agriculture | -0.846 | 0.0202 | 0.0947 | -0.821 | 0.0341 | 0.1706 |
| Forest | 0.767 | 0.0379 | 0.0947 | 0.679 | 0.1095 | 0.2738 |

## Lielupės mažieji intakai — Platonis
- Station: **Vaineikių VMS** (`vaineikiu-vms`), 3.9 km from the basin's estimated outlet along a 15.8 km mapped reach.
- Hydrology metric used: **discharge** (7 usable years out of 9).
- Years used: 2017, 2018, 2020, 2021, 2022, 2023, 2024 (n=7)

| Class | Pearson r | Pearson p | Pearson q (FDR) | Spearman r | Spearman p | Spearman q (FDR) |
|---|---|---|---|---|---|---|
| Water | 0.292 | 0.5192 | 0.5482 | 0.393 | 0.3956 | 0.6594 |
| Wetland | 0.530 | 0.2363 | 0.3938 | 0.286 | 0.5560 | 0.6949 |
| Urban | 0.622 | 0.1325 | 0.3715 | 0.536 | 0.2357 | 0.5893 |
| Agriculture | -0.611 | 0.1486 | 0.3715 | -0.607 | 0.1667 | 0.5893 |
| Forest | 0.276 | 0.5482 | 0.5482 | 0.179 | 0.7131 | 0.7131 |

## Mūša — Mūša
*Note: fragmented river line; using longest component.*
- Station: **Žilpamūšio VMS** (`zilpamusio-vms`), 11.9 km from the basin's estimated outlet along a 111.4 km mapped reach.
- Hydrology metric used: **discharge** (8 usable years out of 9).
- Years used: 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024 (n=8)

| Class | Pearson r | Pearson p | Pearson q (FDR) | Spearman r | Spearman p | Spearman q (FDR) |
|---|---|---|---|---|---|---|
| Water | 0.295 | 0.4771 | 0.5964 | 0.381 | 0.3599 | 0.4867 |
| Wetland | 0.810 | 0.0156 | 0.0780 | 0.690 | 0.0694 | 0.3470 |
| Urban | -0.212 | 0.6182 | 0.6182 | 0.048 | 0.9349 | 0.9349 |
| Agriculture | -0.551 | 0.1561 | 0.3902 | -0.357 | 0.3894 | 0.4867 |
| Forest | 0.475 | 0.2411 | 0.4018 | 0.381 | 0.3599 | 0.4867 |

## Mūša — Lėvuo
- Station: **Bernatonių VMS** (`bernatoniu-levuo-vms`), 48.0 km from the basin's estimated outlet along a 146.9 km mapped reach.
- Hydrology metric used: **discharge** (8 usable years out of 9).
- Years used: 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024 (n=8)

| Class | Pearson r | Pearson p | Pearson q (FDR) | Spearman r | Spearman p | Spearman q (FDR) |
|---|---|---|---|---|---|---|
| Water | 0.198 | 0.6452 | 0.6452 | 0.262 | 0.5364 | 0.6705 |
| Wetland | 0.900 | 0.0017 | 0.0086 | 0.810 | 0.0218 | 0.1089 |
| Urban | -0.447 | 0.2697 | 0.5302 | 0.071 | 0.8820 | 0.8820 |
| Agriculture | -0.333 | 0.4022 | 0.5302 | -0.381 | 0.3599 | 0.5998 |
| Forest | 0.337 | 0.4242 | 0.5302 | 0.452 | 0.2675 | 0.5998 |

## Nemunėlis — Nemunėlis
*Note: fragmented river line; using longest component.*
*Caveat: Catchment shared with Latvia.*
- Station: **Tabokinės VMS** (`tabokines-vms`), 0.0 km from the basin's estimated outlet along a 63.9 km mapped reach.
- Hydrology metric used: **discharge** (8 usable years out of 9).
- Years used: 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024 (n=8)

| Class | Pearson r | Pearson p | Pearson q (FDR) | Spearman r | Spearman p | Spearman q (FDR) |
|---|---|---|---|---|---|---|
| Water | 0.379 | 0.3579 | 0.3579 | -0.071 | 0.8820 | 0.8820 |
| Wetland | 0.545 | 0.1683 | 0.2805 | 0.524 | 0.1966 | 0.3277 |
| Urban | -0.378 | 0.3467 | 0.3579 | -0.310 | 0.4618 | 0.5773 |
| Agriculture | -0.683 | 0.0620 | 0.1549 | -0.667 | 0.0831 | 0.2077 |
| Forest | 0.701 | 0.0499 | 0.1549 | 0.690 | 0.0694 | 0.2077 |

## Bartuvos — Bartuva
*Note: fragmented river line; using longest component.*
- Station: **Skuodo VMS** (`skuodo-vms`), 1.7 km from the basin's estimated outlet along a 9.9 km mapped reach.
- Hydrology metric used: **discharge** (8 usable years out of 9).
- Years used: 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024 (n=8)

| Class | Pearson r | Pearson p | Pearson q (FDR) | Spearman r | Spearman p | Spearman q (FDR) |
|---|---|---|---|---|---|---|
| Water | 0.039 | 0.9137 | 0.9137 | 0.048 | 0.9349 | 1.0000 |
| Wetland | 0.373 | 0.3572 | 0.9137 | 0.333 | 0.4279 | 1.0000 |
| Urban | -0.250 | 0.5666 | 0.9137 | -0.286 | 0.5008 | 1.0000 |
| Agriculture | -0.123 | 0.7568 | 0.9137 | 0.000 | 1.0000 | 1.0000 |
| Forest | 0.166 | 0.6867 | 0.9137 | 0.071 | 0.8820 | 1.0000 |

## Ventos — Venta
*Note: fragmented river line; using longest component.*
- Station: **Leckavos VMS** (`leckavos-vms`), 2.9 km from the basin's estimated outlet along a 143.7 km mapped reach.
- Hydrology metric used: **discharge** (7 usable years out of 9).
- Years used: 2017, 2018, 2019, 2020, 2021, 2022, 2023 (n=7)

| Class | Pearson r | Pearson p | Pearson q (FDR) | Spearman r | Spearman p | Spearman q (FDR) |
|---|---|---|---|---|---|---|
| Water | -0.368 | 0.3992 | 0.9038 | -0.536 | 0.2357 | 0.5556 |
| Wetland | 0.059 | 0.9038 | 0.9038 | 0.214 | 0.6615 | 0.6615 |
| Urban | -0.412 | 0.3746 | 0.9038 | -0.464 | 0.3024 | 0.5556 |
| Agriculture | -0.128 | 0.7700 | 0.9038 | -0.357 | 0.4444 | 0.5556 |
| Forest | 0.235 | 0.6089 | 0.9038 | 0.429 | 0.3536 | 0.5556 |

## Lietuvos pajūrio upių — Danė
- Station: **Klaipėdos VMS** (`klaipedos-vms`), 9.6 km from the basin's estimated outlet along a 30.9 km mapped reach.
- Hydrology metric used: **level** (8 usable years out of 9).
- Years used: 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024 (n=8)

| Class | Pearson r | Pearson p | Pearson q (FDR) | Spearman r | Spearman p | Spearman q (FDR) |
|---|---|---|---|---|---|---|
| Water | -0.469 | 0.2451 | 0.4643 | -0.381 | 0.3599 | 0.6705 |
| Wetland | 0.459 | 0.2566 | 0.4643 | 0.619 | 0.1150 | 0.5749 |
| Urban | 0.191 | 0.6498 | 0.6498 | 0.286 | 0.5008 | 0.6705 |
| Agriculture | -0.439 | 0.2786 | 0.4643 | -0.262 | 0.5364 | 0.6705 |
| Forest | 0.258 | 0.5327 | 0.6498 | 0.167 | 0.7033 | 0.7033 |

## Šventosios (pajūrio) — Šventoji
*Skipped: no observations returned*

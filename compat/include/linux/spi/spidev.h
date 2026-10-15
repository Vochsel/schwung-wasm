/* schwung-wasm: no SPI device in a browser; engine/vspi.c stands in for it. */
#pragma once
#include <stdint.h>
struct spi_ioc_transfer { uint64_t tx_buf, rx_buf; uint32_t len, speed_hz; uint16_t delay_usecs; uint8_t bits_per_word, cs_change; uint32_t pad; };
#define SPI_IOC_MESSAGE(n) (0)
#define SPI_IOC_WR_MODE 0
#define SPI_IOC_WR_MAX_SPEED_HZ 0

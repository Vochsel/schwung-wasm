/* The program's main() only proves the runtime is up; the page calls
 * sw_start() (engine/vspi.c) after the AudioContext exists. */
#include <stdio.h>
int main(void) {
    printf("schwung-wasm engine ready\n");
    return 0;
}

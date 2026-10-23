// SPDX-License-Identifier: Apache-2.0
/* HDL_STATIC.C  Static HDL module registry for the wasm32 build      */
/*                                                                   */
/*   Part of webmvs (patch 0004).                                  */
/*   Linked into Hercules (QPL 1.0); distributed as a separate file. */
/*                                                                   */
/*   The wasm build has no dlopen. hdl.h maps dlopen/dlsym/dlclose/  */
/*   dlerror to the functions below under __EMSCRIPTEN__. Each HDL   */
/*   module source is compiled with -D renames of its 6 entry-point  */
/*   names, for example                                              */
/*     -Dhdl_check_depends_ep=hdt3270_hdl_check_depends_ep           */
/*   and this table maps "module name" + "entry-point name" to the   */
/*   renamed function. hdl_loadmod, the dependency checks, hdl_next  */
/*   chaining (con1052c) and device-type equates (hdteq) stay as in  */
/*   upstream.                                                       */
/*                                                                   */
/*   A lookup of an unknown module or symbol returns NULL, the same  */
/*   as a failed dlopen/dlsym. That matters for                      */
/*   hdl_resolve_symbols_cb (hdl.c), which falls back to dlsym() for */
/*   names that no module registered: the static registry gives      */
/*   NULL there, so every HDL_RESOLVE in a linked module must have a */
/*   matching HDL_REGISTER (today only con1052c 'panel_command').    */

#include "hstdinc.h"
#include "hercules.h"

/* Entry-point function types (hdl.h has DEPSEC etc. as typedefs)    */
#define HDL_STATIC_DECLARE( mod )                                       \
    extern int  mod##_hdl_check_depends_ep    ( DEPCHK* );               \
    extern void mod##_hdl_register_symbols_ep ( REGSYM* ) __attribute__((weak)); \
    extern void mod##_hdl_resolve_symbols_ep  ( GETSYM* ) __attribute__((weak)); \
    extern void mod##_hdl_define_devtypes_ep  ( DEFDEV* ) __attribute__((weak)); \
    extern void mod##_hdl_define_instructs_ep ( DEFINS* ) __attribute__((weak)); \
    extern int  mod##_hdl_on_module_unload_ep ( void    ) __attribute__((weak));

HDL_STATIC_DECLARE( hdteq    )
HDL_STATIC_DECLARE( hdt3270  )
HDL_STATIC_DECLARE( hdt1052c )
HDL_STATIC_DECLARE( hdt3505  )
HDL_STATIC_DECLARE( hdt1403  )
HDL_STATIC_DECLARE( hdt3525  )

typedef struct HDLSTATIC
{
    const char*  name;          /* module name, e.g. "hdt3270"       */
    void*        depsec;        /* hdl_check_depends_ep              */
    void*        regsec;        /* hdl_register_symbols_ep           */
    void*        ressec;        /* hdl_resolve_symbols_ep            */
    void*        devsec;        /* hdl_define_devtypes_ep            */
    void*        inssec;        /* hdl_define_instructs_ep           */
    void*        finsec;        /* hdl_on_module_unload_ep           */
}
HDLSTATIC;

#define HDL_STATIC_ENTRY( mod )                                         \
    { #mod,                                                             \
      (void*) &mod##_hdl_check_depends_ep,                              \
      (void*) &mod##_hdl_register_symbols_ep,                           \
      (void*) &mod##_hdl_resolve_symbols_ep,                            \
      (void*) &mod##_hdl_define_devtypes_ep,                            \
      (void*) &mod##_hdl_define_instructs_ep,                           \
      (void*) &mod##_hdl_on_module_unload_ep }

static const HDLSTATIC hdl_static_tab[] =
{
    HDL_STATIC_ENTRY( hdteq    ),
    HDL_STATIC_ENTRY( hdt3270  ),
    HDL_STATIC_ENTRY( hdt1052c ),
    HDL_STATIC_ENTRY( hdt3505  ),
    HDL_STATIC_ENTRY( hdt1403  ),
    HDL_STATIC_ENTRY( hdt3525  ),
};

#define HDL_STATIC_COUNT  (sizeof( hdl_static_tab ) / sizeof( hdl_static_tab[0] ))

static __thread const char* hdl_static_errmsg = NULL;

/* Return the table entry for a handle, or NULL. The handle of the   */
/* "*Hercules" main module (hdl_main) is not one of ours, so check   */
/* the address range and never dereference an unknown pointer.       */
static const HDLSTATIC* hdl_static_entry( void* handle )
{
    const HDLSTATIC* p = (const HDLSTATIC*) handle;
    if (p < &hdl_static_tab[0] || p >= &hdl_static_tab[ HDL_STATIC_COUNT ])
        return NULL;
    if (((const char*) p - (const char*) &hdl_static_tab[0]) % sizeof( HDLSTATIC ))
        return NULL;
    return p;
}

DLL_EXPORT void* hdl_static_open( const char* name )
{
    char    base[ 64 ];
    const char* p;
    size_t  i, len;

    hdl_static_errmsg = NULL;
    if (!name || !*name)
    {
        hdl_static_errmsg = "no module name";
        return NULL;
    }

    /* basename, without directory */
    p = strrchr( name, '/' );
    p = p ? p + 1 : name;
    strlcpy( base, p, sizeof( base ));

    /* without the module suffix (".so", ".la", ".dll") */
    len = strlen( base );
    if (len > 3 && strcasecmp( base + len - 3, ".so" ) == 0)
        base[ len - 3 ] = 0;
    else if (len > 3 && strcasecmp( base + len - 3, ".la" ) == 0)
        base[ len - 3 ] = 0;
    else if (len > 4 && strcasecmp( base + len - 4, ".dll" ) == 0)
        base[ len - 4 ] = 0;

    for (i = 0; i < HDL_STATIC_COUNT; i++)
        if (strcasecmp( base, hdl_static_tab[i].name ) == 0)
            return (void*) &hdl_static_tab[i];

    hdl_static_errmsg = "module is not linked into the wasm build";
    return NULL;
}

DLL_EXPORT void* hdl_static_sym( void* handle, const char* symbol )
{
    const HDLSTATIC* e = hdl_static_entry( handle );
    void* ret = NULL;

    hdl_static_errmsg = NULL;
    if (e && symbol)
    {
        if      (strcmp( symbol, "hdl_check_depends_ep"    ) == 0) ret = e->depsec;
        else if (strcmp( symbol, "hdl_register_symbols_ep" ) == 0) ret = e->regsec;
        else if (strcmp( symbol, "hdl_resolve_symbols_ep"  ) == 0) ret = e->ressec;
        else if (strcmp( symbol, "hdl_define_devtypes_ep"  ) == 0) ret = e->devsec;
        else if (strcmp( symbol, "hdl_define_instructs_ep" ) == 0) ret = e->inssec;
        else if (strcmp( symbol, "hdl_on_module_unload_ep" ) == 0) ret = e->finsec;
    }
    if (!ret)
        hdl_static_errmsg = "symbol not found in static registry";
    return ret;
}

DLL_EXPORT int hdl_static_close( void* handle )
{
    UNREFERENCED( handle );
    return 0;       /* (modules are part of the binary) */
}

DLL_EXPORT const char* hdl_static_error( void )
{
    return hdl_static_errmsg ? hdl_static_errmsg : "unknown error";
}

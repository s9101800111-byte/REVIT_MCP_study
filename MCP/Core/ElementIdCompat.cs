using Autodesk.Revit.DB;

namespace RevitMCP
{
    public static class ElementIdCompat
    {
        public static int GetIdValue(this ElementId id)
        {
#if NET8_0_OR_GREATER
            return (int)id.Value;
#else
            return id.IntegerValue;
#endif
        }

        public static ElementId Create(int id)
        {
#if NET8_0_OR_GREATER
            return new ElementId((long)id);
#else
            return new ElementId(id);
#endif
        }

        public static ElementId Create(long id)
        {
#if NET8_0_OR_GREATER
            return new ElementId(id);
#else
            return new ElementId((int)id);
#endif
        }
    }
}
